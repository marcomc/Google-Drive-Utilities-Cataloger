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
    ;;
  pull)
    [[ "$*" == "-A ${auth_file} pull" ]] || exit 6
    ;;
  push)
    [[ "$*" == "-A ${auth_file} push --force" ]] || exit 6
    ;;
  version)
    [[ "$*" == "-A ${auth_file} --json version main-111111111111" ]] || exit 6
    ;;
  deploy)
    [[ "$*" == "-A ${auth_file} --json deploy --deploymentId ${TEST_LISTED_DEPLOYMENT_ID} --versionNumber 5 --description main-111111111111" ]] || exit 6
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
url=""
expect_header=0
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
    https://*)
      url="${argument}"
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
expected_url="https://script.googleapis.com/v1/projects/test-script/deployments/${TEST_LISTED_DEPLOYMENT_ID}"
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

if [[ "${TEST_DEPLOYMENT_SCENARIO}" == "missing" ]]; then
  exit 22
fi

script_id="test-script"
version_number=4
access="MYSELF"
entry_point_type="EXECUTION_API"
extra_entry_point=false
extra_entry_point_access="MYSELF"
entry_point_marker=""
if [[ "${call_count}" -gt 1 ]]; then
  version_number=5
fi
case "${TEST_DEPLOYMENT_SCENARIO}" in
  valid)
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

jq -n \
  --arg deployment_id "${TEST_LISTED_DEPLOYMENT_ID}" \
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
FAKE_CURL
chmod +x "${FAKE_BIN}/git" "${FAKE_BIN}/clasp" "${FAKE_BIN}/curl"

run_fixture() {
  local fixture_dir="$1"
  local deploy_sha="$2"
  local current_sha="$3"
  local configured_deployment_id="$4"
  local listed_deployment_id="$5"
  local scenario="$6"

  mkdir -p "${fixture_dir}/runner/clasp-auth"
  jq -n --arg token "test-access-token-do-not-log" \
    '{tokens: {default: {access_token: $token}}}' \
    >"${fixture_dir}/runner/clasp-auth/.clasprc.json"
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

CURRENT_SHA="1111111111111111111111111111111111111111"
STALE_SHA="2222222222222222222222222222222222222222"

success_dir="${TEST_ROOT}/success"
mkdir -p "${success_dir}"
run_fixture "${success_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "valid"
success_time_zone="$(jq -r '.timeZone' "${success_dir}/appsscript.json")"
success_commands="$(tr '\n' ' ' <"${success_dir}/commands.log")"
test "${success_time_zone}" = "Europe/Rome"
test "${success_commands}" = \
  "clasp-deployments api-get-1 clasp-pull clasp-push clasp-version clasp-deploy clasp-deployments api-get-2 "
if grep -q 'test-access-token-do-not-log' "${success_dir}/output.log"; then
  printf '%s\n' "Deployment logs exposed the clasp access token." >&2
  exit 1
fi

stale_dir="${TEST_ROOT}/stale"
mkdir -p "${stale_dir}"
run_fixture "${stale_dir}" "${STALE_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "valid"
test ! -s "${stale_dir}/commands.log"

for scenario in missing wrong-script missing-entry-point wrong-access mixed-public; do
  failure_dir="${TEST_ROOT}/${scenario}"
  mkdir -p "${failure_dir}"
  # Fixture failure is the expected result for invalid deployments.
  # shellcheck disable=SC2310
  if run_fixture "${failure_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-1" "${scenario}"; then
    printf 'Invalid deployment scenario was accepted: %s\n' "${scenario}" >&2
    exit 1
  fi
  assert_failure_before_push "${failure_dir}"
done

changed_dir="${TEST_ROOT}/changed-after"
mkdir -p "${changed_dir}"
# Fixture failure is the expected result for entry-point drift.
# shellcheck disable=SC2310
if run_fixture "${changed_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1" "changed-after"; then
  printf '%s\n' "Post-update entry-point drift was accepted." >&2
  exit 1
fi
changed_deploy_count="$(grep -c '^clasp-deploy$' \
  "${changed_dir}/commands.log")"
test "${changed_deploy_count}" -eq 1

mismatch_dir="${TEST_ROOT}/mismatch"
mkdir -p "${mismatch_dir}"
# Fixture failure is the expected result for an ID mismatch.
# shellcheck disable=SC2310
if run_fixture "${mismatch_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-other" "valid"; then
  printf '%s\n' "Mismatched deployment ID was accepted." >&2
  exit 1
fi
assert_failure_before_push "${mismatch_dir}"

if find "${TEST_ROOT}" -name output.log -exec \
  grep -l 'test-access-token-do-not-log' {} + | grep -q .; then
  printf '%s\n' "Deployment logs exposed the clasp access token." >&2
  exit 1
fi

printf '%s\n' "Apps Script deployment tests passed."
