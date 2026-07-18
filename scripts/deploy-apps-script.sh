#!/usr/bin/env bash

set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${APPS_SCRIPT_DEPLOYMENT_ID:?APPS_SCRIPT_DEPLOYMENT_ID is required}"
: "${DEPLOY_COMMIT_SHA:?DEPLOY_COMMIT_SHA is required}"

[[ "${DEPLOY_COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]
auth_dir="${RUNNER_TEMP}/clasp-auth"
test -f "${auth_dir}/.clasprc.json"
jq -e '
  type == "object" and
  (.scriptId | type == "string" and length > 0) and
  .rootDir == "."
' .clasp.json >/dev/null

git fetch --no-tags origin main
current_main_sha="$(git rev-parse FETCH_HEAD)"
if [[ "${DEPLOY_COMMIT_SHA}" != "${current_main_sha}" ]]; then
  printf '%s\n' "A newer main revision exists; skipping stale deployment."
  exit 0
fi

deployments_json="$(clasp -A "${auth_dir}" --json deployments)"
jq -e --arg id "${APPS_SCRIPT_DEPLOYMENT_ID}" '
  any(.[];
    .deploymentId == $id and
    (.versionNumber | type == "number")
  )
' <<<"${deployments_json}" >/dev/null

snapshot_dir="${RUNNER_TEMP}/apps-script-snapshot"
mkdir -m 700 "${snapshot_dir}"
cp .clasp.json "${snapshot_dir}/.clasp.json"
(
  cd "${snapshot_dir}"
  clasp -A "${auth_dir}" pull
)
remote_time_zone="$(jq -er '
  .timeZone | select(type == "string" and length > 0)
' "${snapshot_dir}/appsscript.json")"
manifest_tmp="$(mktemp "${RUNNER_TEMP}/appsscript.XXXXXX")"
jq --arg time_zone "${remote_time_zone}" \
  '.timeZone = $time_zone' appsscript.json >"${manifest_tmp}"
mv "${manifest_tmp}" appsscript.json

version_label="main-${DEPLOY_COMMIT_SHA::12}"
clasp -A "${auth_dir}" push --force
version_json="$(clasp -A "${auth_dir}" --json version "${version_label}")"
version_id="$(jq -er '
  .versionNumber | select(type == "number")
' <<<"${version_json}")"
deployment_json="$(clasp -A "${auth_dir}" --json deploy \
  --deploymentId "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  --versionNumber "${version_id}" \
  --description "${version_label}")"
jq -e \
  --arg id "${APPS_SCRIPT_DEPLOYMENT_ID}" \
  --argjson version "${version_id}" '
    .deploymentId == $id and .versionNumber == $version
  ' <<<"${deployment_json}" >/dev/null
