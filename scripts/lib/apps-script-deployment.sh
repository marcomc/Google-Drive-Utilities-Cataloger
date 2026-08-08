#!/usr/bin/env bash

# Shared Apps Script deployment inspection and validation helpers.

declare -a CLASP

run_apps_script_clasp_json() {
  local auth_file="$1"
  local result_variable="$2"
  local clasp_output
  local clasp_refresh_error_file

  shift 2
  if ! clasp_output="$(
    clasp_refresh_error_file="$(mktemp)" || {
      printf '%s\n' \
        'Could not create temporary authorization-inspection state.' >&2
      exit 1
    }
    trap 'rm -f "${clasp_refresh_error_file}"' EXIT
    if ! "${CLASP[@]}" -A "${auth_file}" --json "$@" \
      2>"${clasp_refresh_error_file}"; then
      if grep -Fq 'invalid_grant' "${clasp_refresh_error_file}"; then
        printf '%s\n' \
          'OAuth refresh token is invalid or expired; reauthorize the owner Desktop OAuth client and replace CLASP_AUTH_JSON.' >&2
      else
        printf '%s\n' \
          'Could not refresh authorization for Apps Script deployment operation.' >&2
      fi
      exit 1
    fi
  )"; then
    return 1
  fi

  if [[ -n "${result_variable}" ]]; then
    printf -v "${result_variable}" '%s' "${clasp_output}"
  fi
}

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

  if ! run_apps_script_clasp_json \
    "${auth_file}" \
    "" \
    deployments; then
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

read_apps_script_version_content() {
  local auth_file="$1"
  local script_id="$2"
  local version_number="$3"
  local result_variable="$4"
  local access_token
  local response_json
  local content_url
  local http_response
  local http_status
  local curl_status

  if [[ ! "${script_id}" =~ ^[A-Za-z0-9_-]+$ ||
    ! "${version_number}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' 'Invalid Apps Script version identity.' >&2
    return 1
  fi

  access_token="$(jq -er '
    .tokens.default.access_token |
    select(type == "string" and length > 0)
  ' "${auth_file}" 2>/dev/null)" || {
    printf '%s\n' \
      'The clasp authorization does not contain a usable access token.' >&2
    return 1
  }

  content_url="https://script.googleapis.com/v1/projects/${script_id}/content?versionNumber=${version_number}"
  if http_response="$(
    printf 'Authorization: Bearer %s\nAccept: application/json\n' \
      "${access_token}" |
      curl --silent --show-error --header @- \
        --write-out $'\n%{http_code}' \
        "${content_url}" 2>/dev/null
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi
  unset access_token
  if [[ "${curl_status}" -ne 0 ]]; then
    case "${curl_status}" in
      6) printf '%s\n' 'Could not resolve the Apps Script API host.' >&2 ;;
      7) printf '%s\n' 'Could not connect to the Apps Script API.' >&2 ;;
      28) printf '%s\n' 'The Apps Script API request timed out.' >&2 ;;
      35|60) printf '%s\n' 'Apps Script API TLS validation failed.' >&2 ;;
      *) printf 'Apps Script version content transport failed with curl status %s.\n' \
        "${curl_status}" >&2 ;;
    esac
    return 1
  fi
  if [[ "${http_response}" != *$'\n'* ]]; then
    printf '%s\n' 'The Apps Script API returned no HTTP status.' >&2
    return 1
  fi
  http_status="${http_response##*$'\n'}"
  response_json="${http_response%$'\n'*}"
  case "${http_status}" in
    200) ;;
    403) printf '%s\n' 'Apps Script version inspection authorization was denied.' >&2; return 1 ;;
    404) printf 'Apps Script version %s does not exist or is not accessible.\n' \
      "${version_number}" >&2; return 1 ;;
    429) printf '%s\n' 'Apps Script version inspection was rate limited.' >&2; return 1 ;;
    5??) printf '%s\n' 'The Apps Script API is temporarily unavailable.' >&2; return 1 ;;
    *) printf 'Apps Script version inspection failed with HTTP %s.\n' \
      "${http_status}" >&2; return 1 ;;
  esac

  if ! jq -e 'type == "object" and (.files | type == "array")' \
    <<<"${response_json}" >/dev/null; then
    printf '%s\n' 'The Apps Script version content response was invalid.' >&2
    return 1
  fi
  printf -v "${result_variable}" '%s' "${response_json}"
}

validate_apps_script_version_entrypoints() {
  local content_json="$1"
  shift
  local entrypoint
  local sources_json

  sources_json="$(jq -c '[.files[]? | select((.type? == "SERVER_JS" or .type? == null) and (.source | type == "string")) | .source]' <<<"${content_json}")" || {
    printf '%s\n' 'Apps Script version content sources were invalid.' >&2
    return 1
  }

  for entrypoint in "$@"; do
    if ! printf '%s' "${sources_json}" | node -e '
      const entrypoint = process.argv[1];
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const sources = JSON.parse(input);
        const isTopLevel = (source) => {
          let depth = 0;
          let state = "code";
          for (let i = 0; i < source.length; i += 1) {
            const character = source[i];
            const next = source[i + 1];
            if (state === "line-comment") {
              if (character === "\\n") state = "code";
              continue;
            }
            if (state === "block-comment") {
              if (character === "*" && next === "/") { state = "code"; i += 1; }
              continue;
            }
            if (state === "single" || state === "double" || state === "template") {
              if (character === "\\") { i += 1; continue; }
              if ((state === "single" && character === String.fromCharCode(39)) ||
                  (state === "double" && character === String.fromCharCode(34)) ||
                  (state === "template" && character === String.fromCharCode(96))) state = "code";
              continue;
            }
            if (character === "/" && next === "/") { state = "line-comment"; i += 1; continue; }
            if (character === "/" && next === "*") { state = "block-comment"; i += 1; continue; }
            if (character === String.fromCharCode(39)) { state = "single"; continue; }
            if (character === String.fromCharCode(34)) { state = "double"; continue; }
            if (character === String.fromCharCode(96)) { state = "template"; continue; }
            if (character === "{") { depth += 1; continue; }
            if (character === "}") { depth = Math.max(0, depth - 1); continue; }
            if (depth === 0 && source.slice(i).match(new RegExp("^function\\s+" + entrypoint + "\\s*\\("))) {
              return true;
            }
          }
          return false;
        };
        process.exit(sources.some(isTopLevel) ? 0 : 1);
      });
    ' "${entrypoint}"; then
      printf 'Apps Script version is missing required entrypoint %s.\n' \
        "${entrypoint}" >&2
      return 1
    fi
  done
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

find_owner_only_api_deployment() {
  local auth_file="$1"
  local script_id="$2"
  local result_variable="$3"
  local deployments_json
  local candidate_id
  local deployment_json
  local deployment_ids
  local selected_id=""
  local match_count=0

  deployments_json=""
  if ! run_apps_script_clasp_json \
    "${auth_file}" \
    deployments_json \
    deployments; then
    return 1
  fi
  if ! jq -e 'type == "array"' <<<"${deployments_json}" >/dev/null; then
    printf '%s\n' "The Apps Script deployment list is invalid." >&2
    return 1
  fi
  deployment_ids="$(jq -r '.[] | .deploymentId // empty' \
    <<<"${deployments_json}")"

  while IFS= read -r candidate_id; do
    [[ -n "${candidate_id}" ]] || continue
    deployment_json=""
    if ! read_apps_script_deployment \
      "${auth_file}" \
      "${script_id}" \
      "${candidate_id}" \
      deployment_json; then
      printf 'Could not inspect Apps Script deployment %s during discovery.\n' \
        "${candidate_id}" >&2
      return 1
    fi
    if validate_owner_only_api_deployment \
      "${deployment_json}" \
      "${script_id}" \
      "${candidate_id}" >/dev/null 2>&1; then
      selected_id="${candidate_id}"
      match_count=$((match_count + 1))
    fi
  done <<<"${deployment_ids}"

  if [[ "${match_count}" -ne 1 ]]; then
    printf 'Expected exactly one owner-only Apps Script deployment; found %s.\n' \
      "${match_count}" >&2
    return 1
  fi
  printf -v "${result_variable}" '%s' "${selected_id}"
}

wait_for_expected_apps_script_deployment() {
  local auth_file="$1"
  local script_id="$2"
  local deployment_id="$3"
  local retryable_stale_version="$4"
  local expected_version="$5"
  local result_variable="$6"
  local deployment_json
  local observed_version
  local verification_attempt
  local verification_attempts=5
  local verification_delay_seconds=2

  if [[ ! "${retryable_stale_version}" =~ ^[0-9]+$ ||
    ! "${expected_version}" =~ ^[0-9]+$ ||
    "${retryable_stale_version}" == "${expected_version}" ]]; then
    printf '%s\n' "Invalid Apps Script deployment version transition." >&2
    return 1
  fi

  for ((verification_attempt = 1;
    verification_attempt <= verification_attempts;
    verification_attempt++)); do
    if ! sleep "${verification_delay_seconds}"; then
      printf '%s\n' "Apps Script deployment verification delay was interrupted." >&2
      return 1
    fi
    deployment_json=""
    if ! read_apps_script_deployment \
      "${auth_file}" \
      "${script_id}" \
      "${deployment_id}" \
      deployment_json; then
      return 1
    fi
    if ! validate_owner_only_api_deployment \
      "${deployment_json}" \
      "${script_id}" \
      "${deployment_id}"; then
      return 1
    fi
    observed_version="$(jq -er \
      '.deploymentConfig.versionNumber | select(type == "number")' \
      <<<"${deployment_json}")"
    if [[ "${observed_version}" == "${expected_version}" ]]; then
      printf -v "${result_variable}" '%s' "${deployment_json}"
      return 0
    fi
    if [[ "${observed_version}" != "${retryable_stale_version}" ]]; then
      printf 'The Apps Script deployment exposed unexpected version %s; expected %s or prior version %s.\n' \
        "${observed_version}" "${expected_version}" \
        "${retryable_stale_version}" >&2
      return 1
    fi
  done

  printf 'The Apps Script deployment did not expose expected version %s after %s checks.\n' \
    "${expected_version}" "${verification_attempts}" >&2
  return 1
}

canonical_deployment_entry_points() {
  local deployment_json="$1"

  jq -cerS '(.entryPoints // []) | sort_by(tojson)' \
    <<<"${deployment_json}"
}
