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
for argument in "$@"; do
  case "${argument}" in
    deployments | pull | push | version | deploy)
      command_name="${argument}"
      break
      ;;
  esac
done
case "${command_name}" in
  deployments)
    printf '[{"deploymentId":"%s","versionNumber":4}]\n' \
      "${TEST_LISTED_DEPLOYMENT_ID}"
    ;;
  pull)
    printf '%s\n' '{"timeZone":"Europe/Rome"}' >appsscript.json
    ;;
  push)
    printf '%s\n' push >>"${TEST_COMMAND_LOG}"
    ;;
  version)
    printf '%s\n' version >>"${TEST_COMMAND_LOG}"
    printf '%s\n' '{"versionNumber":5}'
    ;;
  deploy)
    printf '%s\n' deploy >>"${TEST_COMMAND_LOG}"
    printf '{"deploymentId":"%s","versionNumber":5}\n' \
      "${TEST_LISTED_DEPLOYMENT_ID}"
    ;;
  *)
    exit 2
    ;;
esac
FAKE_CLASP
chmod +x "${FAKE_BIN}/git" "${FAKE_BIN}/clasp"

run_fixture() {
  local fixture_dir="$1"
  local deploy_sha="$2"
  local current_sha="$3"
  local configured_deployment_id="$4"
  local listed_deployment_id="$5"

  mkdir -p "${fixture_dir}/runner/clasp-auth"
  printf '%s\n' '{}' >"${fixture_dir}/runner/clasp-auth/.clasprc.json"
  printf '%s\n' '{"scriptId":"test-script","rootDir":"."}' \
    >"${fixture_dir}/.clasp.json"
  printf '%s\n' '{"timeZone":"Etc/UTC"}' >"${fixture_dir}/appsscript.json"
  : >"${fixture_dir}/commands.log"
  (
    cd "${fixture_dir}"
    PATH="${FAKE_BIN}:${PATH}" \
      RUNNER_TEMP="${fixture_dir}/runner" \
      APPS_SCRIPT_DEPLOYMENT_ID="${configured_deployment_id}" \
      DEPLOY_COMMIT_SHA="${deploy_sha}" \
      TEST_CURRENT_MAIN_SHA="${current_sha}" \
      TEST_LISTED_DEPLOYMENT_ID="${listed_deployment_id}" \
      TEST_COMMAND_LOG="${fixture_dir}/commands.log" \
      "${PROJECT_ROOT}/scripts/deploy-apps-script.sh"
  )
}

CURRENT_SHA="1111111111111111111111111111111111111111"
STALE_SHA="2222222222222222222222222222222222222222"
actual_commands=""
actual_time_zone=""

success_dir="${TEST_ROOT}/success"
mkdir -p "${success_dir}"
run_fixture "${success_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1"
actual_time_zone="$(jq -r '.timeZone' "${success_dir}/appsscript.json")"
test "${actual_time_zone}" = "Europe/Rome"
actual_commands="$(tr '\n' ' ' <"${success_dir}/commands.log")"
test "${actual_commands}" = "push version deploy "

stale_dir="${TEST_ROOT}/stale"
mkdir -p "${stale_dir}"
run_fixture "${stale_dir}" "${STALE_SHA}" "${CURRENT_SHA}" \
  "deployment-1" "deployment-1"
test ! -s "${stale_dir}/commands.log"

mismatch_dir="${TEST_ROOT}/mismatch"
mkdir -p "${mismatch_dir}"
set +e
(
  set -e
  run_fixture "${mismatch_dir}" "${CURRENT_SHA}" "${CURRENT_SHA}" \
    "deployment-1" "deployment-other"
) >/dev/null 2>&1
mismatch_status=$?
set -e
if [[ "${mismatch_status}" -eq 0 ]]; then
  printf '%s\n' "Mismatched deployment ID was accepted." >&2
  exit 1
fi
test ! -s "${mismatch_dir}/commands.log"

printf '%s\n' "Apps Script deployment tests passed."
