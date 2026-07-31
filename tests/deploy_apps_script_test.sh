#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

FAKE_BIN="${TEST_ROOT}/bin"
mkdir -p "${FAKE_BIN}"

cat >"${FAKE_BIN}/git" <<'FAKE_GIT'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  fetch)
    ;;
  rev-parse)
    printf '%s\n' "${TEST_CURRENT_MAIN_SHA}"
    ;;
  *)
    exit 2
    ;;
esac
FAKE_GIT

cat >"${FAKE_BIN}/clasp" <<'FAKE_CLASP'
#!/usr/bin/env bash
set -euo pipefail
command_name=""
auth_file=""
expect_auth_file=0
for argument in "$@"; do
  if [[ "${expect_auth_file}" -eq 1 ]]; then
    auth_file="${argument}"
    expect_auth_file=0
    continue
  fi
  case "${argument}" in
    -A)
      expect_auth_file=1
      ;;
    deployments | pull | push | version | deploy)
      command_name="${argument}"
      break
      ;;
  esac
done
if [[ "${auth_file}" != */.clasprc.json || ! -f "${auth_file}" ]]; then
  printf '%s\n' "clasp -A must reference an existing .clasprc.json file" >&2
  exit 3
fi
case "${command_name}" in
  deployments)
    [[ "$*" == "-A ${auth_file} --json deployments" ]] || exit 6
    case "${TEST_DEPLOYMENT_SCENARIO}" in
      oauth-invalid-grant)
        printf '%s\n' 'invalid_grant' >&2
        exit 9
        ;;
      oauth-refresh-failure)
        printf '%s\n' 'authorization refresh failed' >&2
        exit 9
        ;;
    esac
    ;;
  pull)
    [[ "$*" == "-A ${auth_file} pull" ]] || exit 6
    ;;
  push)
    [[ "$*" == "-A ${auth_file} push --force" ]] || exit 6
    ;;
  version)
    [[ "$*" == "-A ${auth_file} --json version main-111111111111" ]] || exit 6
    if [[ "${TEST_DEPLOYMENT_SCENARIO}" == 'oauth-invalid-grant-on-version' ]]; then
      printf '%s\n' 'invalid_grant' >&2
      exit 9
    fi
    ;;
  deploy)
    [[ "$*" == "-A ${auth_file} --json deploy --deploymentId ${TEST_LISTED_DEPLOYMENT_ID} --versionNumber 5 --description main-111111111111" ]] || exit 6
    if [[ "${TEST_DEPLOYMENT_SCENARIO}" == 'oauth-invalid-grant-on-deploy' ]]; then
      printf '%s\n' 'invalid_grant' >&2
      exit 9
    fi
    ;;
  *)
    exit 2
    ;;
esac
printf 'clasp-%s\n' "${command_name}" >>"${TEST_COMMAND_LOG}"
case "${command_name}" in
  deployments)
    printf '[{"deploymentId":"%s","versionNumber":4}]\n' \
      "${TEST_LISTED_DEPLOYMENT_ID}"
    ;;
  pull)
    printf '%s\n' '{"timeZone":"Europe/Rome"}' >appsscript.json
    ;;
  push)
    ;;
  version)
    printf '%s\n' '{"versionNumber":5}'
    ;;
  deploy)
    printf '{"deploymentId":"%s","versionNumber":5}\n' \
      "${TEST_LISTED_DEPLOYMENT_ID}"
    ;;
  *)
    exit 2
    ;;
esac
FAKE_CLASP

cat >"${FAKE_BIN}/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

authorization=""
header_source=""
expect_header=0
for argument in "$@"; do
  if [[ "${argument}" == Authorization:* ]]; then
    printf '%s\n' "Authorization header must not be passed through argv." >&2
    exit 7
  fi
done
if [[ "$#" -ne 7 || "$1" != "--silent" || "$2" != "--show-error" ||
  "$3" != "--header" || "$4" != "@-" || "$5" != "--write-out" ||
  "$6" != $'\n%{http_code}' ]]; then
  printf '%s\n' "Unexpected curl argument shape." >&2
  exit 8
fi
url="$7"
for argument in "$@"; do
  if [[ "${expect_header}" -eq 1 ]]; then
    if [[ "${argument}" == "@-" ]]; then
      header_source="stdin"
    elif [[ "${argument}" == Authorization:* ]]; then
      authorization="${argument}"
    fi
    expect_header=0
    continue
  fi
  case "${argument}" in
    -H | --header)
      expect_header=1
      ;;
  esac
done
if [[ "${header_source}" == "stdin" ]]; then
  while IFS= read -r header; do
    if [[ "${header}" == Authorization:* ]]; then
      authorization="${header}"
    fi
  done
fi
if [[ "${authorization}" != "Authorization: Bearer ${TEST_ACCESS_TOKEN}" ]]; then
  exit 3
fi
expected_url="https://script.googleapis.com/v1/projects/test-script/deployments/${TEST_CONFIGURED_DEPLOYMENT_ID}"
if [[ "${url}" != "${expected_url}" ]]; then
  exit 4
fi
call_count=0
if [[ -f "${TEST_API_CALL_COUNT_FILE}" ]]; then
  call_count="$(<"${TEST_API_CALL_COUNT_FILE}")"
fi
call_count=$((call_count + 1))
printf '%s\n' "${call_count}" >"${TEST_API_CALL_COUNT_FILE}"
printf 'api-get-%s\n' "${call_count}" >>"${TEST_COMMAND_LOG}"

case "${TEST_DEPLOYMENT_SCENARIO}" in
  transport-dns) exit 6 ;;
  transport-connect) exit 7 ;;
  transport-timeout) exit 28 ;;
  transport-tls) exit 60 ;;
esac

script_id="test-script"
version_number=4
access="MYSELF"
entry_point_type="EXECUTION_API"
extra_entry_point=false
extra_entry_point_access="MYSELF"
entry_point_marker=""
http_status=200
if [[ "${call_count}" -gt 1 ]]; then
  version_number=5
fi
case "${TEST_DEPLOYMENT_SCENARIO}" in
  valid | oauth-invalid-grant-on-version | oauth-invalid-grant-on-deploy)
    ;;
  missing)
    http_status=404
    ;;
  api-forbidden)
    http_status=403
    ;;
  api-rate-limited)
    http_status=429
    ;;
  api-unavailable)
    http_status=503
    ;;
  post-api-forbidden)
    if [[ "${call_count}" -gt 1 ]]; then
      http_status=403
    fi
    ;;
  post-api-rate-limited)
    if [[ "${call_count}" -gt 1 ]]; then
      http_status=429
    fi
    ;;
  post-api-unavailable)
    if [[ "${call_count}" -gt 1 ]]; then
      http_status=503
    fi
    ;;
  wrong-script)
    script_id="other-script"
    ;;
  missing-entry-point)
    entry_point_type="WEB_APP"
    ;;
  wrong-access)
    access="ANYONE"
    ;;
  mixed-public)
    extra_entry_point=true
    extra_entry_point_access="ANYONE"
    ;;
  changed-after)
    if [[ "${call_count}" -gt 1 ]]; then
      entry_point_marker="changed"
    fi
    ;;
  *)
    exit 5
    ;;
esac

if [[ "${http_status}" -ne 200 ]]; then
  printf '{"error":{"code":%s}}\n%s' "${http_status}" "${http_status}"
  exit 0
fi

jq -n \
  --arg deployment_id "${TEST_RESPONSE_DEPLOYMENT_ID}" \
  --arg script_id "${script_id}" \
  --argjson version_number "${version_number}" \
  --arg entry_point_type "${entry_point_type}" \
  --arg access "${access}" \
  --argjson extra_entry_point "${extra_entry_point}" \
  --arg extra_entry_point_access "${extra_entry_point_access}" \
  --arg entry_point_marker "${entry_point_marker}" '
    {
      deploymentId: $deployment_id,
      deploymentConfig: {
        scriptId: $script_id,
        versionNumber: $version_number,
        manifestFileName: "appsscript",
        description: "fixture"
      },
      entryPoints: ([{
        entryPointType: $entry_point_type,
        executionApi: ({entryPointConfig: {access: $access}} +
          if $entry_point_marker == "" then {}
          else {testMarker: $entry_point_marker} end)
      }] + if $extra_entry_point then [{
        entryPointType: "WEB_APP",
        webApp: {
          entryPointConfig: {
            access: $extra_entry_point_access,
            executeAs: "USER_DEPLOYING"
          }
        }
      }] else [] end)
    }
  '
printf '\n200'
FAKE_CURL
chmod +x "${FAKE_BIN}/git" "${FAKE_BIN}/clasp" "${FAKE_BIN}/curl"

run_fixture() {
  local fixture_dir="$1"
  local deploy_sha="$2"
  local current_sha="$3"
  local configured_deployment_id="$4"
  local listed_deployment_id="$5"
  local scenario="$6"
  local response_deployment_id="${7:-${listed_deployment_id}}"

  mkdir -p "${fixture_dir}/runner/clasp-auth"
  if [[ "${scenario}" != "missing-auth" ]]; then
    jq -n \
      --arg token "test-access-token-do-not-log" \
      --arg nondefault_token "wrong-account-token-do-not-use" \
      '{tokens: {
        other: {access_token: $nondefault_token},
        default: {access_token: $token}
      }}' \
      >"${fixture_dir}/runner/clasp-auth/.clasprc.json"
  fi
  printf '%s\n' '{"scriptId":"test-script","rootDir":"."}' \
    >"${fixture_dir}/.clasp.json"
  printf '%s\n' '{"timeZone":"Etc/UTC"}' >"${fixture_dir}/appsscript.json"
  : >"${fixture_dir}/commands.log"
  : >"${fixture_dir}/api-call-count"
  (
    cd "${fixture_dir}"
    PATH="${FAKE_BIN}:${PATH}" \
      RUNNER_TEMP="${fixture_dir}/runner" \
      APPS_SCRIPT_DEPLOYMENT_ID="${configured_deployment_id}" \
      DEPLOY_COMMIT_SHA="${deploy_sha}" \
      TEST_CURRENT_MAIN_SHA="${current_sha}" \
      TEST_LISTED_DEPLOYMENT_ID="${listed_deployment_id}" \
      TEST_CONFIGURED_DEPLOYMENT_ID="${configured_deployment_id}" \
      TEST_RESPONSE_DEPLOYMENT_ID="${response_deployment_id}" \
      TEST_DEPLOYMENT_SCENARIO="${scenario}" \
      TEST_ACCESS_TOKEN="test-access-token-do-not-log" \
      TEST_API_CALL_COUNT_FILE="${fixture_dir}/api-call-count" \
      TEST_COMMAND_LOG="${fixture_dir}/commands.log" \
      "${PROJECT_ROOT}/scripts/deploy-apps-script.sh"
  ) >"${fixture_dir}/output.log" 2>&1
}

assert_failure_before_push() {
  local fixture_dir="$1"
  if grep -Eq '^clasp-(push|version|deploy)$' "${fixture_dir}/commands.log"; then
    printf '%s\n' "Invalid deployment caused a source mutation." >&2
    exit 1
  fi
}

require_fixture_failure() {
  local failure_message="$1"
  local fixture_status

  shift
  set +e
  run_fixture "$@"
  fixture_status=$?
  set -e
  if [[ "${fixture_status}" -eq 0 ]]; then
    printf '%s\n' "${failure_message}" >&2
    exit 1
  fi
}

CURRENT_SHA="1111111111111111111111111111111111111111"
STALE_SHA="2222222222222222222222222222222222222222"

missing_auth_dir="${TEST_ROOT}/missing-auth"
mkdir -p "${missing_auth_dir}"
require_fixture_failure \
  "Missing clasp authorization was accepted." \
  "${missing_auth_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "missing-auth"
test ! -s "${missing_auth_dir}/commands.log"
grep -q 'CLASP_AUTH_JSON' "${missing_auth_dir}/output.log"

success_dir="${TEST_ROOT}/success"
mkdir -p "${success_dir}"
run_fixture "${success_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "valid"
success_time_zone="$(jq -r '.timeZone' "${success_dir}/appsscript.json")"
success_commands="$(tr '\n' ' ' <"${success_dir}/commands.log")"
test "${success_time_zone}" = "Europe/Rome"
test "${success_commands}" = \
  "clasp-deployments api-get-1 clasp-pull clasp-push clasp-version clasp-deploy clasp-deployments api-get-2 "
if grep -q 'token-do-not' "${success_dir}/output.log"; then
  printf '%s\n' "Deployment logs exposed the clasp access token." >&2
  exit 1
fi

stale_dir="${TEST_ROOT}/stale"
mkdir -p "${stale_dir}"
run_fixture "${stale_dir}" "${STALE_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "valid"
test ! -s "${stale_dir}/commands.log"

invalid_grant_dir="${TEST_ROOT}/oauth-invalid-grant"
mkdir -p "${invalid_grant_dir}"
require_fixture_failure \
  'An invalid OAuth refresh token was accepted.' \
  "${invalid_grant_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "oauth-invalid-grant"
assert_failure_before_push "${invalid_grant_dir}"
grep -q 'OAuth refresh token is invalid or expired' \
  "${invalid_grant_dir}/output.log"

oauth_refresh_failure_dir="${TEST_ROOT}/oauth-refresh-failure"
mkdir -p "${oauth_refresh_failure_dir}"
require_fixture_failure \
  'An unclassified OAuth refresh failure was accepted.' \
  "${oauth_refresh_failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "oauth-refresh-failure"
assert_failure_before_push "${oauth_refresh_failure_dir}"
grep -q 'Could not refresh authorization for Apps Script deployment operation' \
  "${oauth_refresh_failure_dir}/output.log"

post_push_invalid_grant_dir="${TEST_ROOT}/oauth-invalid-grant-on-deploy"
post_push_invalid_grant_commands=""
mkdir -p "${post_push_invalid_grant_dir}"
require_fixture_failure \
  'An OAuth refresh failure after source upload was accepted.' \
  "${post_push_invalid_grant_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "oauth-invalid-grant-on-deploy"
post_push_invalid_grant_commands="$(tr '\n' ' ' <"${post_push_invalid_grant_dir}/commands.log")"
if [[ "${post_push_invalid_grant_commands}" != \
  'clasp-deployments api-get-1 clasp-pull clasp-push clasp-version ' ]]; then
  printf 'Unexpected commands before OAuth deployment failure: %s\n' \
    "${post_push_invalid_grant_commands}" >&2
  sed -n '1,160p' "${post_push_invalid_grant_dir}/output.log" >&2
  exit 1
fi
grep -q 'OAuth refresh token is invalid or expired' \
  "${post_push_invalid_grant_dir}/output.log"
grep -q 'deployment update failed after source upload' \
  "${post_push_invalid_grant_dir}/output.log"

post_push_version_invalid_grant_dir="${TEST_ROOT}/oauth-invalid-grant-on-version"
mkdir -p "${post_push_version_invalid_grant_dir}"
require_fixture_failure \
  'An OAuth refresh failure during version creation was accepted.' \
  "${post_push_version_invalid_grant_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "oauth-invalid-grant-on-version"
post_push_version_invalid_grant_commands="$(tr '\n' ' ' <"${post_push_version_invalid_grant_dir}/commands.log")"
if [[ "${post_push_version_invalid_grant_commands}" != \
  'clasp-deployments api-get-1 clasp-pull clasp-push ' ]]; then
  printf 'Unexpected commands before OAuth version failure: %s\n' \
    "${post_push_version_invalid_grant_commands}" >&2
  sed -n '1,160p' "${post_push_version_invalid_grant_dir}/output.log" >&2
  exit 1
fi
grep -q 'OAuth refresh token is invalid or expired' \
  "${post_push_version_invalid_grant_dir}/output.log"
grep -q 'version creation failed after source upload' \
  "${post_push_version_invalid_grant_dir}/output.log"

for scenario in missing wrong-script missing-entry-point wrong-access mixed-public; do
  failure_dir="${TEST_ROOT}/${scenario}"
  mkdir -p "${failure_dir}"
  require_fixture_failure \
    "Invalid deployment scenario was accepted: ${scenario}" \
    "${failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-1" "${scenario}"
  assert_failure_before_push "${failure_dir}"
done

for scenario_and_message in \
  "api-forbidden:authorization was denied" \
  "api-rate-limited:rate limited" \
  "api-unavailable:temporarily unavailable"; do
  scenario="${scenario_and_message%%:*}"
  expected_message="${scenario_and_message#*:}"
  failure_dir="${TEST_ROOT}/${scenario}"
  mkdir -p "${failure_dir}"
  require_fixture_failure \
    "Deployment API failure was accepted: ${scenario}" \
    "${failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-1" "${scenario}"
  assert_failure_before_push "${failure_dir}"
  grep -q "${expected_message}" "${failure_dir}/output.log"
done

for scenario_and_message in \
  "transport-dns:Could not resolve" \
  "transport-connect:Could not connect" \
  "transport-timeout:timed out" \
  "transport-tls:TLS validation failed"; do
  scenario="${scenario_and_message%%:*}"
  expected_message="${scenario_and_message#*:}"
  failure_dir="${TEST_ROOT}/${scenario}"
  mkdir -p "${failure_dir}"
  require_fixture_failure \
    "Deployment transport failure was accepted: ${scenario}" \
    "${failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-1" "${scenario}"
  assert_failure_before_push "${failure_dir}"
  grep -q "${expected_message}" "${failure_dir}/output.log"
done

for scenario in \
  post-api-forbidden \
  post-api-rate-limited \
  post-api-unavailable; do
  failure_dir="${TEST_ROOT}/${scenario}"
  mkdir -p "${failure_dir}"
  require_fixture_failure \
    "Post-update API failure was accepted: ${scenario}" \
    "${failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-1" "${scenario}"
  mutation_commands="$(grep -Ec '^clasp-(push|version|deploy)$' \
    "${failure_dir}/commands.log")"
  test "${mutation_commands}" -eq 3
  grep -q 'post-update API verification failed' \
    "${failure_dir}/output.log"
done

changed_dir="${TEST_ROOT}/changed-after"
mkdir -p "${changed_dir}"
require_fixture_failure \
  "Post-update entry-point drift was accepted." \
  "${changed_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "changed-after"
changed_deploy_count="$(grep -c '^clasp-deploy$' \
  "${changed_dir}/commands.log")"
test "${changed_deploy_count}" -eq 1

mismatch_dir="${TEST_ROOT}/mismatch"
mkdir -p "${mismatch_dir}"
require_fixture_failure \
  "Mismatched deployment ID was accepted." \
  "${mismatch_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "valid" "deployment-other"
assert_failure_before_push "${mismatch_dir}"

if find "${TEST_ROOT}" -name output.log -exec \
  grep -l 'token-do-not' {} + | grep -q .; then
  printf '%s\n' "Deployment logs exposed the clasp access token." >&2
  exit 1
fi

printf '%s\n' "Apps Script deployment tests passed."
