#!/usr/bin/env bash

# Shared Apps Script deployment inspection and validation helpers.

declare -a CLASP

read_apps_script_deployment() {
  local auth_file="$1"
  local script_id="$2"
  local deployment_id="$3"
  local result_variable="$4"
  local access_token
  local deployment_json
  local deployment_url

  if [[ ! "${script_id}" =~ ^[A-Za-z0-9_-]+$ ||
    ! "${deployment_id}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    printf '%s\n' "Invalid Apps Script deployment identity." >&2
    return 1
  fi

  if ! "${CLASP[@]}" -A "${auth_file}" --json deployments >/dev/null; then
    printf '%s\n' \
      "Could not refresh authorization for Apps Script deployment inspection." >&2
    return 1
  fi
  access_token="$(jq -er '
    [.tokens[]? | .access_token? |
      select(type == "string" and length > 0)][0]
  ' "${auth_file}" 2>/dev/null)" || {
    printf '%s\n' \
      "The clasp authorization does not contain a usable access token." >&2
    return 1
  }

  deployment_url="https://script.googleapis.com/v1/projects/${script_id}/deployments/${deployment_id}"
  if ! deployment_json="$(
    printf 'Authorization: Bearer %s\nAccept: application/json\n' \
      "${access_token}" |
      curl --fail --silent --show-error --header @- \
        "${deployment_url}" 2>/dev/null
  )"; then
    unset access_token
    printf 'Could not read Apps Script deployment %s via the Deployments API.\n' \
      "${deployment_id}" >&2
    return 1
  fi
  unset access_token

  if ! jq -e 'type == "object"' <<<"${deployment_json}" >/dev/null; then
    printf '%s\n' "The Apps Script Deployments API returned invalid JSON." >&2
    return 1
  fi
  printf -v "${result_variable}" '%s' "${deployment_json}"
}

validate_owner_only_api_deployment() {
  local deployment_json="$1"
  local expected_script_id="$2"
  local expected_deployment_id="$3"
  local expected_version="${4:-}"

  if ! jq -e \
    --arg script_id "${expected_script_id}" \
    --arg deployment_id "${expected_deployment_id}" '
      .deploymentId == $deployment_id and
      .deploymentConfig.scriptId == $script_id and
      (.deploymentConfig.versionNumber | type == "number") and
      (.deploymentConfig.manifestFileName |
        type == "string" and length > 0)
    ' <<<"${deployment_json}" >/dev/null; then
    printf '%s\n' \
      "The Apps Script deployment identity or configuration is invalid." >&2
    return 1
  fi

  if [[ -n "${expected_version}" ]] &&
    ! jq -e --argjson version "${expected_version}" \
      '.deploymentConfig.versionNumber == $version' \
      <<<"${deployment_json}" >/dev/null; then
    printf 'The Apps Script deployment is not on expected version %s.\n' \
      "${expected_version}" >&2
    return 1
  fi

  if ! jq -e '
    (.entryPoints | type == "array" and length == 1) and
    .entryPoints[0].entryPointType == "EXECUTION_API" and
    .entryPoints[0].executionApi.entryPointConfig.access == "MYSELF"
  ' <<<"${deployment_json}" >/dev/null; then
    printf '%s\n' \
      "The Apps Script deployment is not an owner-only API executable." >&2
    return 1
  fi
}

canonical_deployment_entry_points() {
  local deployment_json="$1"

  jq -cerS '(.entryPoints // []) | sort_by(tojson)' \
    <<<"${deployment_json}"
}
