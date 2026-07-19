#!/usr/bin/env bash

# Shared Apps Script deployment inspection and validation helpers.

declare -a CLASP

read_apps_script_deployment() {
  local auth_file="$1"
  local script_id="$2"
  local deployment_id="$3"
  local result_variable="$4"
  local access_token
  local response_json
  local deployment_url
  local http_response
  local http_status
  local curl_status

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
    .tokens.default.access_token |
    select(type == "string" and length > 0)
  ' "${auth_file}" 2>/dev/null)" || {
    printf '%s\n' \
      "The clasp authorization does not contain a usable access token." >&2
    return 1
  }

  deployment_url="https://script.googleapis.com/v1/projects/${script_id}/deployments/${deployment_id}"
  if http_response="$(
    printf 'Authorization: Bearer %s\nAccept: application/json\n' \
      "${access_token}" |
      curl --silent --show-error --header @- \
        --write-out $'\n%{http_code}' \
        "${deployment_url}" 2>/dev/null
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi
  unset access_token
  if [[ "${curl_status}" -ne 0 ]]; then
    case "${curl_status}" in
      6) printf '%s\n' "Could not resolve the Apps Script API host." >&2 ;;
      7) printf '%s\n' "Could not connect to the Apps Script API." >&2 ;;
      28) printf '%s\n' "The Apps Script API request timed out." >&2 ;;
      35|60) printf '%s\n' "Apps Script API TLS validation failed." >&2 ;;
      *) printf 'Apps Script deployment inspection transport failed with curl status %s.\n' \
        "${curl_status}" >&2 ;;
    esac
    return 1
  fi
  if [[ "${http_response}" != *$'\n'* ]]; then
    printf '%s\n' "The Apps Script Deployments API returned no HTTP status." >&2
    return 1
  fi
  http_status="${http_response##*$'\n'}"
  response_json="${http_response%$'\n'*}"
  case "${http_status}" in
    200)
      ;;
    403)
      printf '%s\n' \
        "Apps Script deployment inspection authorization was denied." >&2
      return 1
      ;;
    404)
      printf 'Apps Script deployment %s does not exist or is not accessible.\n' \
        "${deployment_id}" >&2
      return 1
      ;;
    429)
      printf '%s\n' "Apps Script deployment inspection was rate limited." >&2
      return 1
      ;;
    5??)
      printf '%s\n' \
        "The Apps Script Deployments API is temporarily unavailable." >&2
      return 1
      ;;
    *)
      printf 'Apps Script deployment inspection failed with HTTP %s.\n' \
        "${http_status}" >&2
      return 1
      ;;
  esac

  if ! jq -e 'type == "object"' <<<"${response_json}" >/dev/null; then
    printf '%s\n' "The Apps Script Deployments API returned invalid JSON." >&2
    return 1
  fi
  printf -v "${result_variable}" '%s' "${response_json}"
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
      .deploymentConfig.manifestFileName == "appsscript"
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
