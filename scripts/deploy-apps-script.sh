#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=scripts/lib/apps-script-deployment.sh
source "${SCRIPT_DIR}/lib/apps-script-deployment.sh"

CLASP=(clasp)

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${APPS_SCRIPT_DEPLOYMENT_ID:?APPS_SCRIPT_DEPLOYMENT_ID is required}"
: "${DEPLOY_COMMIT_SHA:?DEPLOY_COMMIT_SHA is required}"

[[ "${DEPLOY_COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]
auth_dir="${RUNNER_TEMP}/clasp-auth"
auth_file="${auth_dir}/.clasprc.json"
if [[ ! -f "${auth_file}" ]]; then
  printf '%s\n' \
    "Missing clasp authorization prepared from the CLASP_AUTH_JSON secret: ${auth_file}" >&2
  exit 1
fi
jq -e '
  type == "object" and
  (.scriptId | type == "string" and length > 0) and
  .rootDir == "."
' .clasp.json >/dev/null
script_id="$(jq -er '.scriptId' .clasp.json)"

git fetch --no-tags origin main
current_main_sha="$(git rev-parse FETCH_HEAD)"
if [[ "${DEPLOY_COMMIT_SHA}" != "${current_main_sha}" ]]; then
  printf '%s\n' "A newer main revision exists; skipping stale deployment."
  exit 0
fi

pre_deployment_json=""
# Helpers explicitly check each fallible command; callers branch for diagnostics.
# shellcheck disable=SC2310
if ! read_apps_script_deployment \
  "${auth_file}" \
  "${script_id}" \
  "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  pre_deployment_json; then
  printf '%s\n' \
    "Deployment preflight failed; no Apps Script source was changed." >&2
  exit 1
fi
# shellcheck disable=SC2310
if ! validate_owner_only_api_deployment \
  "${pre_deployment_json}" \
  "${script_id}" \
  "${APPS_SCRIPT_DEPLOYMENT_ID}"; then
  printf '%s\n' \
    "Deployment preflight failed; explicit operator repair is required." >&2
  exit 1
fi
pre_entry_points="$(canonical_deployment_entry_points \
  "${pre_deployment_json}")"

snapshot_dir="${RUNNER_TEMP}/apps-script-snapshot"
mkdir -m 700 "${snapshot_dir}"
cp .clasp.json "${snapshot_dir}/.clasp.json"
(
  cd "${snapshot_dir}"
  "${CLASP[@]}" -A "${auth_file}" pull
)
remote_time_zone="$(jq -er '
  .timeZone | select(type == "string" and length > 0)
' "${snapshot_dir}/appsscript.json")"
manifest_tmp="$(mktemp "${RUNNER_TEMP}/appsscript.XXXXXX")"
jq --arg time_zone "${remote_time_zone}" \
  '.timeZone = $time_zone' appsscript.json >"${manifest_tmp}"
mv "${manifest_tmp}" appsscript.json

version_label="main-${DEPLOY_COMMIT_SHA::12}"
"${CLASP[@]}" -A "${auth_file}" push --force
version_json=""
# Helpers explicitly check failures; this branch adds post-push recovery guidance.
# shellcheck disable=SC2310
if ! run_apps_script_clasp_json \
  "${auth_file}" \
  version_json \
  version \
  "${version_label}"; then
  printf '%s\n' \
    "Apps Script version creation failed after source upload; rerun the current deployment workflow to reconcile project HEAD and the API executable." >&2
  exit 1
fi
version_id="$(jq -er '
  .versionNumber | select(type == "number")
' <<<"${version_json}")"
deployment_json=""
# Helpers explicitly check failures; this branch adds post-push recovery guidance.
# shellcheck disable=SC2310
if ! run_apps_script_clasp_json \
  "${auth_file}" \
  deployment_json \
  deploy \
  --deploymentId "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  --versionNumber "${version_id}" \
  --description "${version_label}"; then
  printf '%s\n' \
    "Apps Script deployment update failed after source upload; rerun the current deployment workflow to reconcile project HEAD and the API executable." >&2
  exit 1
fi
jq -e \
  --arg id "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  --argjson version "${version_id}" '
    .deploymentId == $id and .versionNumber == $version
  ' <<<"${deployment_json}" >/dev/null

post_deployment_json=""
# The Deployments API can briefly expose the prior version after an accepted
# update. Retry only that eventual-consistency mismatch; identity and access
# failures remain fail-closed in the shared helper.
# shellcheck disable=SC2310
if ! wait_for_expected_apps_script_deployment \
  "${auth_file}" \
  "${script_id}" \
  "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  "${version_id}" \
  post_deployment_json; then
  printf '%s\n' \
    "The deployment was updated but post-update API verification failed." >&2
  exit 1
fi
post_entry_points="$(canonical_deployment_entry_points \
  "${post_deployment_json}")"
if [[ "${post_entry_points}" != "${pre_entry_points}" ]]; then
  printf '%s\n' \
    "The Apps Script deployment entry points changed during the update." >&2
  exit 1
fi
