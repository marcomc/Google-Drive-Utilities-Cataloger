#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

make_fixture() {
  local fixture_name="$1"
  local fixture_root="${TEST_ROOT}/${fixture_name}/project"
  local oauth_file="${TEST_ROOT}/${fixture_name}/oauth-client.json"

  mkdir -p \
    "${fixture_root}/.installer" \
    "${fixture_root}/fake-bin" \
    "${fixture_root}/locales"
  cp -R "${PROJECT_ROOT}/scripts" "${fixture_root}/scripts"
  cp "${PROJECT_ROOT}"/*.gs "${fixture_root}/"
  cp "${PROJECT_ROOT}"/locales/*.gs "${fixture_root}/locales/"
  cp "${PROJECT_ROOT}/appsscript.json" "${fixture_root}/appsscript.json"
  cp "${PROJECT_ROOT}/config.example.json" \
    "${fixture_root}/config.example.json"
  cp "${PROJECT_ROOT}/AGENTS.example.md" "${fixture_root}/AGENTS.example.md"
  jq '
    .canonical_suppliers = ["TEST WATER", "TEST ENERGY", "TEST INTERNET"] |
    .supplier_aliases = {
      "TEST WATER LTD": "TEST WATER",
      "TEST ENERGY LTD": "TEST ENERGY"
    } |
    .address_rules = [
      {"match": "TEST IMPORT ADDRESS", "type": "import"},
      {"match": "TEST ARCHIVE ADDRESS", "type": "archive_only"}
    ] |
    .destination_templates = {
      "Water|TEST WATER": "Water/{year}",
      "Electricity|TEST ENERGY": "Electricity/{year}",
      "Internet|TEST INTERNET": "Internet/{year}"
    } |
    .time_zone = "Pacific/Auckland"
  ' "${PROJECT_ROOT}/config.example.json" >"${fixture_root}/config.local.json"
  printf '%s\n' '{"scriptId":"test-script","rootDir":"."}' \
    >"${fixture_root}/.clasp.json"
  printf '%s\n' 'google-drive-utilities-cataloger' \
    >"${fixture_root}/.installer/.gduc-installer-state"
  jq -n '{
    installerVersion: 1,
    phase: "complete",
    projectId: "test-project-123",
    projectNumber: "123456789",
    scriptId: "test-script",
    deploymentId: "test-deployment",
    locale: "en",
    timeZone: "Europe/Rome",
    pendingTimeZone: "",
    bootstrapSecretVersion: ""
  }' >"${fixture_root}/.installer/state.json"
  jq -n '{installed: {
    client_id: "123456789-test.apps.googleusercontent.com"
  }}' >"${oauth_file}"
  cp "${fixture_root}/appsscript.json" \
    "${TEST_ROOT}/${fixture_name}/original-appsscript.json"

  cat >"${fixture_root}/fake-bin/gcloud" <<'FAKE_GCLOUD'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "auth list --filter=status:ACTIVE --format=value(account) --limit=1")
    printf '%s\n' 'owner@example.com'
    ;;
  "projects list --limit=1")
    ;;
  "billing accounts list --filter=open=true --format=value(name)")
    printf '%s\n' 'billingAccounts/000000-000000-000000'
    ;;
  *)
    printf 'unexpected gcloud invocation: %s\n' "$*" >&2
    exit 91
    ;;
esac
FAKE_GCLOUD

  cat >"${fixture_root}/fake-bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '%s\n' "curl $*" >>"${TEST_COMMAND_LOG}"
printf '%s\n200' '{"deploymentId":"test-deployment","deploymentConfig":{"scriptId":"test-script","versionNumber":4,"manifestFileName":"appsscript"},"entryPoints":[{"entryPointType":"EXECUTION_API","executionApi":{"entryPointConfig":{"access":"MYSELF"}}}]}'
FAKE_CURL

  cat >"${fixture_root}/fake-bin/npx" <<'FAKE_NPX'
#!/usr/bin/env bash
set -euo pipefail

auth_file=""
staging_dir=""
previous=""
printf '%s\n' "npx $*" >>"${TEST_COMMAND_LOG}"
for argument in "$@"; do
  case "${previous}" in
    -A) auth_file="${argument}" ;;
    -P) staging_dir="${argument}" ;;
  esac
  previous="${argument}"
done

case " $* " in
  *" --version "*)
    printf '%s\n' '3.3.0'
    ;;
  *" login "*)
    mkdir -p "$(dirname "${auth_file}")"
    jq -n '{tokens: {default: {access_token: "fixture-access-token"}}}' \
      >"${auth_file}"
    ;;
  *" show-authorized-user "*)
    printf '%s\n' '{"loggedIn":true,"email":"owner@example.com"}'
    ;;
  *" --json deployments "*)
    printf '%s\n' '[]'
    ;;
  *" pull "*)
    jq -n '{
      timeZone: "Europe/Rome",
      runtimeVersion: "V8",
      exceptionLogging: "STACKDRIVER",
      installationField: "preserve-me"
    }' \
      >"${staging_dir}/appsscript.json"
    printf '%s\n' 'function remoteSourceMarker() {}' \
      >"${staging_dir}/Remote.gs"
    ;;
  *" push --force "*)
    pushed_time_zone="$(jq -r '.timeZone' "${staging_dir}/appsscript.json")"
    printf 'push-time-zone %s\n' "${pushed_time_zone}" \
      >>"${TEST_COMMAND_LOG}"
    jq -e '
      .timeZone == "Pacific/Auckland" or
      .timeZone == "Europe/Rome"
    ' \
      "${staging_dir}/appsscript.json" >/dev/null
    jq -e --arg time_zone "${pushed_time_zone}" \
      '.timeZone == $time_zone' appsscript.json >/dev/null
    test -f "${staging_dir}/Remote.gs"
    test ! -f "${staging_dir}/Installer.gs"
    jq -e '
      .runtimeVersion == "V8" and
      .exceptionLogging == "STACKDRIVER" and
      .installationField == "preserve-me"
    ' "${staging_dir}/appsscript.json" >/dev/null
    if [[ "${TEST_PUSH_INTERRUPT:-false}" == "true" ]]; then
      kill -TERM "${PPID}"
      exit 143
    fi
    if [[ "${TEST_PUSH_FAILURE:-false}" == "true" &&
      "${pushed_time_zone}" == "Pacific/Auckland" ]]; then
      exit 17
    fi
    if [[ "${TEST_ROLLBACK_PUSH_FAILURE:-false}" == "true" &&
      "${pushed_time_zone}" == "Europe/Rome" ]]; then
      exit 19
    fi
    ;;
  *" --json run beginCatalogerTimeZoneReconfiguration "*)
    test "${auth_file}" = "${PWD}/.installer/clasp-auth/.clasprc.json"
    test "${*: -2:1}" = '--params'
    requested_time_zone="$(jq -er '.[0].timeZone' <<<"${!#}")"
    jq -cn --arg time_zone "${requested_time_zone}" '{response: {
      transactionId: "transaction-1",
      previousTimeZone: "Europe/Rome",
      targetTimeZone: $time_zone
    }}'
    ;;
  *" --json run reconfigureCatalogerTimeZone "*)
    test "${auth_file}" = "${PWD}/.installer/clasp-auth/.clasprc.json"
    test "${*: -2:1}" = '--params'
    requested_time_zone="$(jq -er '.[0].timeZone' <<<"${!#}")"
    jq -e '
      length == 1 and
      (.[0] | keys) == ["timeZone", "transactionId"] and
      .[0].transactionId == "transaction-1"
    ' <<<"${!#}" >/dev/null
    if [[ "${TEST_RUN_FAILURE:-false}" == "true" &&
      "${requested_time_zone}" == "Pacific/Auckland" ]]; then
      exit 23
    fi
    if [[ "${TEST_RUN_INTERRUPT:-false}" == "true" ]]; then
      kill -TERM "${PPID}"
      exit 143
    fi
    jq -cn --arg time_zone "${requested_time_zone}" '{response: {
      configured: true,
      timeZone: $time_zone,
      transactionId: "transaction-1",
      automaticProcessingPreserved: true
    }}'
    ;;
  *" --json run rollbackCatalogerTimeZoneReconfiguration "*)
    if [[ "${TEST_ROLLBACK_RUN_FAILURE:-false}" == "true" ]]; then
      exit 29
    fi
    if [[ "${TEST_ROLLBACK_INVALID_JSON:-false}" == "true" ]]; then
      printf '%s\n' '{"response":{"configured":false}}'
      exit 0
    fi
    jq -e '.[0].transactionId == "transaction-1"' <<<"${!#}" >/dev/null
    jq -cn '{response: {
      configured: true,
      timeZone: "Europe/Rome",
      transactionId: "transaction-1"
    }}'
    ;;
  *" --json run finishCatalogerTimeZoneReconfiguration "*)
    expected_time_zone="$(jq -er '.[0].expectedTimeZone' <<<"${!#}")"
    jq -cn --arg time_zone "${expected_time_zone}" '{response: {
      completed: true,
      timeZone: $time_zone
    }}'
    ;;
  *)
    printf 'unexpected npx invocation: %s\n' "$*" >&2
    exit 92
    ;;
esac
FAKE_NPX
  chmod +x "${fixture_root}/fake-bin/gcloud" \
    "${fixture_root}/fake-bin/curl" \
    "${fixture_root}/fake-bin/npx"
}

assert_manifest_restored() {
  local fixture_name="$1"
  local fixture_root="${TEST_ROOT}/${fixture_name}/project"

  cmp \
    "${TEST_ROOT}/${fixture_name}/original-appsscript.json" \
    "${fixture_root}/appsscript.json"
  if find "${fixture_root}" "${fixture_root}/.installer" \
    -maxdepth 1 \
    \( -name 'appsscript.backup.*' -o -name 'appsscript.json.tmp.*' \) \
    -print -quit | grep -q .; then
    printf '%s\n' 'temporary manifest files remain after installer exit' >&2
    exit 1
  fi
}

run_reconfiguration() {
  local fixture_name="$1"
  local fixture_root="${TEST_ROOT}/${fixture_name}/project"
  shift

  (
    cd "${fixture_root}"
    PATH="${fixture_root}/fake-bin:${PATH}" \
      TEST_COMMAND_LOG="${TEST_ROOT}/${fixture_name}/commands.log" \
      GDUC_OAUTH_CLIENT_JSON="${TEST_ROOT}/${fixture_name}/oauth-client.json" \
      "$@" ./scripts/install.sh --reconfigure-time-zone --non-interactive
  )
}

state_value() {
  local fixture_name="$1"
  local expression="$2"

  jq -r "${expression}" \
    "${TEST_ROOT}/${fixture_name}/project/.installer/state.json"
}

make_fixture success
set +e
run_reconfiguration success env
success_status=$?
set -e
if [[ "${success_status}" -ne 0 ]]; then
  cat "${TEST_ROOT}/success/commands.log" >&2
  exit "${success_status}"
fi
assert_manifest_restored success
success_time_zone="$(state_value success '.timeZone')"
success_pending_time_zone="$(state_value success '.pendingTimeZone')"
test "${success_time_zone}" = 'Pacific/Auckland'
test "${success_pending_time_zone}" = ''
test ! -d "${TEST_ROOT}/success/project/.installer/clasp-auth"

make_fixture failure
set +e
run_reconfiguration failure env TEST_PUSH_FAILURE=true
failure_status=$?
set -e
test "${failure_status}" -eq 17
assert_manifest_restored failure
failure_time_zone="$(state_value failure '.timeZone')"
failure_pending_time_zone="$(state_value failure '.pendingTimeZone')"
test "${failure_time_zone}" = 'Europe/Rome'
test "${failure_pending_time_zone}" = 'Pacific/Auckland'
failure_push_count="$(grep -c '^push-time-zone ' \
  "${TEST_ROOT}/failure/commands.log")"
test "${failure_push_count}" -eq 2

make_fixture interrupted
set +e
run_reconfiguration interrupted env TEST_PUSH_INTERRUPT=true
interrupt_status=$?
set -e
test "${interrupt_status}" -ne 0
assert_manifest_restored interrupted
interrupted_time_zone="$(state_value interrupted '.timeZone')"
test "${interrupted_time_zone}" = 'Europe/Rome'

make_fixture remote-failure
set +e
run_reconfiguration remote-failure env TEST_RUN_FAILURE=true
remote_failure_status=$?
set -e
test "${remote_failure_status}" -ne 0
assert_manifest_restored remote-failure
remote_failure_time_zone="$(state_value remote-failure '.timeZone')"
remote_failure_pending_time_zone="$(state_value \
  remote-failure '.pendingTimeZone')"
test "${remote_failure_time_zone}" = 'Europe/Rome'
test "${remote_failure_pending_time_zone}" = 'Pacific/Auckland'
remote_failure_push_count="$(grep -c '^push-time-zone ' \
  "${TEST_ROOT}/remote-failure/commands.log")"
test "${remote_failure_push_count}" -eq 2
grep -q '^push-time-zone Pacific/Auckland$' \
  "${TEST_ROOT}/remote-failure/commands.log"
grep -q '^push-time-zone Europe/Rome$' \
  "${TEST_ROOT}/remote-failure/commands.log"

make_fixture rollback-push-failure
set +e
run_reconfiguration rollback-push-failure env \
  TEST_RUN_FAILURE=true TEST_ROLLBACK_PUSH_FAILURE=true
rollback_push_failure_status=$?
set -e
test "${rollback_push_failure_status}" -ne 0
assert_manifest_restored rollback-push-failure
rollback_push_failure_pending="$(state_value \
  rollback-push-failure '.pendingTimeZone')"
test "${rollback_push_failure_pending}" = 'Pacific/Auckland'

make_fixture rollback-run-failure
set +e
run_reconfiguration rollback-run-failure env \
  TEST_RUN_FAILURE=true TEST_ROLLBACK_RUN_FAILURE=true
rollback_run_failure_status=$?
set -e
test "${rollback_run_failure_status}" -ne 0
assert_manifest_restored rollback-run-failure
test -d "${TEST_ROOT}/rollback-run-failure/project/.installer/clasp-auth"

make_fixture rollback-invalid-json
set +e
run_reconfiguration rollback-invalid-json env \
  TEST_RUN_FAILURE=true TEST_ROLLBACK_INVALID_JSON=true
rollback_invalid_json_status=$?
set -e
test "${rollback_invalid_json_status}" -ne 0
assert_manifest_restored rollback-invalid-json
rollback_invalid_json_pending="$(state_value \
  rollback-invalid-json '.pendingTimeZone')"
test "${rollback_invalid_json_pending}" = 'Pacific/Auckland'

make_fixture runtime-interrupted
set +e
run_reconfiguration runtime-interrupted env TEST_RUN_INTERRUPT=true
runtime_interrupt_status=$?
set -e
test "${runtime_interrupt_status}" -ne 0
assert_manifest_restored runtime-interrupted
runtime_interrupt_pending="$(state_value \
  runtime-interrupted '.pendingTimeZone')"
test "${runtime_interrupt_pending}" = 'Pacific/Auckland'
run_reconfiguration runtime-interrupted env
runtime_interrupt_time_zone="$(state_value \
  runtime-interrupted '.timeZone')"
test "${runtime_interrupt_time_zone}" = 'Pacific/Auckland'

make_fixture recovered
cp "${TEST_ROOT}/recovered/original-appsscript.json" \
  "${TEST_ROOT}/recovered/project/.installer/appsscript.backup.stale"
jq '.timeZone = "Asia/Tokyo"' \
  "${TEST_ROOT}/recovered/project/appsscript.json" \
  >"${TEST_ROOT}/recovered/project/appsscript.mutated"
mv "${TEST_ROOT}/recovered/project/appsscript.mutated" \
  "${TEST_ROOT}/recovered/project/appsscript.json"
run_reconfiguration recovered
assert_manifest_restored recovered
recovered_time_zone="$(state_value recovered '.timeZone')"
test "${recovered_time_zone}" = 'Pacific/Auckland'

printf '%s\n' 'Installer time-zone push tests passed.'
