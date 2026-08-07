#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_STATE_DIR="$(mktemp -d)"
export GDUC_STATE_DIR="${TEST_STATE_DIR}"

# shellcheck source=scripts/install.sh
source "${PROJECT_ROOT}/scripts/install.sh"
TEMP_PATHS+=("${TEST_STATE_DIR}")

failures=0

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [[ "${expected}" != "${actual}" ]]; then
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' \
      "${message}" "${expected}" "${actual}" >&2
    failures=$((failures + 1))
  fi
}

assert_success() {
  local message="$1"
  shift

  if ! "$@"; then
    printf 'FAIL: %s\n' "${message}" >&2
    failures=$((failures + 1))
  fi
}

assert_failure() {
  local message="$1"
  shift

  if "$@"; then
    printf 'FAIL: %s\n' "${message}" >&2
    failures=$((failures + 1))
  fi
}

test_drive_id_extraction() {
  local actual

  actual="$(extract_google_resource_id \
    "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz_12345?usp=sharing")"
  assert_equal \
    "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345" \
    "${actual}" \
    "extract a Drive folder ID"

  actual="$(extract_google_resource_id \
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_12345/edit#gid=0")"
  assert_equal \
    "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345" \
    "${actual}" \
    "extract a spreadsheet ID"

  actual="$(extract_google_resource_id \
    "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345")"
  assert_equal \
    "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345" \
    "${actual}" \
    "accept a raw Google resource ID"

  assert_failure "reject a non-Google resource value" \
    extract_google_resource_id "not-a-resource-id"
}

test_input_validation() {
  assert_success "accept a valid project ID" \
    is_valid_project_id "drive-utilities-demo-123"
  assert_failure "reject an uppercase project ID" \
    is_valid_project_id "Drive-Utilities"
  assert_failure "reject a project ID ending in a hyphen" \
    is_valid_project_id "drive-utilities-"

  assert_success "accept an email address" \
    is_valid_email "operator@example.com"
  assert_failure "reject an invalid email address" \
    is_valid_email "operator"

  assert_success "accept a supported locale" is_supported_locale "en"
  assert_success "accept the Italian locale" is_supported_locale "it"
  assert_failure "reject an unsupported locale" is_supported_locale "fr"

  assert_success "accept a valid IANA time zone" \
    is_valid_time_zone "Europe/Rome"
  assert_failure "reject an invalid IANA time zone" \
    is_valid_time_zone "Europe/Not-A-Zone"
  assert_failure "reject a fixed positive UTC offset" \
    is_valid_time_zone "+02:00"
  assert_failure "reject a fixed negative UTC offset" \
    is_valid_time_zone "-05:30"
  assert_failure "reject whitespace around an IANA time zone" \
    is_valid_time_zone " Europe/Rome "

  assert_success "accept a Gemini model identifier" \
    is_valid_gemini_model "gemini-2.5-flash"
  assert_failure "reject a Gemini model resource path" \
    is_valid_gemini_model "models/gemini-2.5-flash"

  assert_success "accept the global Vertex location" \
    is_valid_vertex_location "global"
  assert_success "accept a regional Vertex location" \
    is_valid_vertex_location "europe-west1"
  assert_failure "reject an invalid Vertex location" \
    is_valid_vertex_location "Europe"

  assert_success "accept Gemini Developer API mode" \
    is_valid_gemini_mode "gemini_api"
  assert_success "accept Vertex fallback mode" \
    is_valid_gemini_mode "gemini_api_with_vertex_fallback"
  assert_failure "reject an unsupported Gemini mode" \
    is_valid_gemini_mode "unsupported"
}

# Invoked indirectly through the assertion helpers.
# shellcheck disable=SC2317,SC2329
validate_test_state_directory() {
  local test_state_dir="$1"

  (
    CUSTOM_STATE_DIR_REQUESTED=1
    STATE_DIR="${test_state_dir}"
    STATE_FILE="${STATE_DIR}/state.json"
    AUTH_DIR="${STATE_DIR}/clasp-auth"
    STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
    validate_state_directory_setting
  ) >/dev/null 2>&1
}

# Invoked indirectly through the assertion helpers.
# shellcheck disable=SC2317,SC2329
validate_test_default_state_directory() {
  local test_state_dir="$1"

  (
    CUSTOM_STATE_DIR_REQUESTED=0
    DEFAULT_STATE_DIR="${test_state_dir}"
    STATE_DIR="${test_state_dir}"
    STATE_FILE="${STATE_DIR}/state.json"
    AUTH_DIR="${STATE_DIR}/clasp-auth"
    STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
    validate_state_directory_setting
  ) >/dev/null 2>&1
}

# Invoked indirectly through the assertion helpers.
# shellcheck disable=SC2317,SC2329
validate_test_legacy_reauthorization_profile() {
  local test_state_dir="$1"

  (
    MODE="reauthorize"
    CUSTOM_STATE_DIR_REQUESTED=0
    DEFAULT_STATE_DIR="${test_state_dir}"
    STATE_DIR="${test_state_dir}"
    STATE_FILE="${STATE_DIR}/state.json"
    AUTH_DIR="${STATE_DIR}/clasp-auth"
    STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
    validate_state_directory_setting
  ) >/dev/null 2>&1
}

test_custom_state_directory_safety() {
  local ancestor_link_root
  local default_link
  local default_unowned
  local external_state_dir
  local nonempty_state_dir
  local state_entry_link
  local symlink_parent
  local symlink_target

  external_state_dir="$(mktemp -d)"
  assert_success "accept an empty external state directory" \
    validate_test_state_directory "${external_state_dir}"

  nonempty_state_dir="$(mktemp -d)"
  printf '%s\n' "unrelated" >"${nonempty_state_dir}/keep.txt"
  assert_failure "reject a nonempty unowned state directory" \
    validate_test_state_directory "${nonempty_state_dir}"

  assert_failure "reject a state directory inside the repository" \
    validate_test_state_directory "${PROJECT_ROOT}/private-installer-state"

  symlink_target="$(mktemp -d)"
  default_link="${symlink_target}-link"
  ln -s "${symlink_target}" "${default_link}"
  assert_failure "reject a symlinked default state directory" \
    validate_test_default_state_directory "${default_link}"

  default_unowned="$(mktemp -d)"
  printf '%s\n' '{}' >"${default_unowned}/state.json"
  assert_failure "reject unmarked default installer state" \
    validate_test_default_state_directory "${default_unowned}"

  local legacy_profile
  legacy_profile="$(mktemp -d)"
  mkdir -p "${legacy_profile}/clasp-auth"
  printf '%s\n' '{}' >"${legacy_profile}/clasp-auth/.clasprc.json"
  assert_success "adopt an exact legacy local clasp profile for reauthorization" \
    validate_test_legacy_reauthorization_profile "${legacy_profile}"
  printf '%s\n' 'unexpected' >"${legacy_profile}/unrelated.txt"
  assert_failure "reject a legacy profile with unrelated state" \
    validate_test_legacy_reauthorization_profile "${legacy_profile}"

  state_entry_link="$(mktemp -d)"
  printf '%s\n' "google-drive-utilities-cataloger" \
    >"${state_entry_link}/.gduc-installer-state"
  ln -s "${symlink_target}" "${state_entry_link}/clasp-auth"
  assert_failure "reject a symlinked installer authorization directory" \
    validate_test_default_state_directory "${state_entry_link}"

  symlink_parent="$(mktemp -d)"
  ancestor_link_root="${symlink_parent}/repository"
  ln -s "${PROJECT_ROOT}" "${ancestor_link_root}"
  assert_failure "reject a custom path whose ancestor resolves into the repository" \
    validate_test_state_directory "${ancestor_link_root}/state"

  rm -rf \
    "${external_state_dir}" \
    "${default_unowned}" \
    "${legacy_profile}" \
    "${nonempty_state_dir}" \
    "${state_entry_link}" \
    "${symlink_parent}" \
    "${symlink_target}"
  rm -f "${default_link}"
}

test_version_parsing() {
  local actual

  actual="$(major_version "v20.19.1")"
  assert_equal "20" "${actual}" "parse a prefixed Node version"
  actual="$(major_version "Google Cloud SDK 471.0.0")"
  assert_equal "471" "${actual}" \
    "parse a version inside text"
}

test_noninteractive_optional_input() {
  local actual="sentinel"

  NON_INTERACTIVE=1
  prompt_optional_value actual "Optional value" ""
  NON_INTERACTIVE=0
  assert_equal "" "${actual}" "accept an empty optional non-interactive value"
}

write_test_state() {
  local gemini_mode="$1"
  local settings_json

  settings_json="$(jq -n \
    --arg geminiMode "${gemini_mode}" \
    '{
      projectName: "Test project",
      projectId: "test-project-123",
      billingAccountId: "000000-000000-000000",
      locale: "en",
      timeZone: "Europe/Rome",
      notificationRecipient: "operator@example.com",
      rootFolderId: "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345",
      spreadsheetId: "",
      spreadsheetTitle: "Test utilities",
      geminiMode: $geminiMode,
      geminiModel: "gemini-2.5-flash",
      vertexAiLocation: "global"
    }')"
  write_initial_state "${settings_json}"
}

test_runtime_service_selection() {
  local actual
  local services

  write_test_state "gemini_api"

  actual="$(state_get '.geminiBackend')"
  assert_equal "gemini_api" "${actual}" \
    "store the effective Gemini backend"
  actual="$(state_get '.geminiApiKeyRequired')"
  assert_equal "true" "${actual}" \
    "store Gemini API key requirement"
  actual="$(state_get '.geminiAutoVertexFallback')"
  assert_equal "false" "${actual}" \
    "preserve a false boolean when reading installer state"
  services="$(required_cloud_services)"
  if grep -q 'aiplatform.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Gemini API-only mode unexpectedly enables Vertex AI\n' >&2
    failures=$((failures + 1))
  fi
  if grep -q 'generativelanguage.googleapis.com' <<<"${services}"; then
    printf 'FAIL: cataloger project unexpectedly owns the Gemini API key\n' >&2
    failures=$((failures + 1))
  fi
  if ! grep -q 'secretmanager.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Gemini API mode does not enable private bootstrap handoff\n' >&2
    failures=$((failures + 1))
  fi

  write_test_state "gemini_api_with_vertex_fallback"
  services="$(required_cloud_services)"
  if ! grep -q 'aiplatform.googleapis.com' <<<"${services}"; then
    printf 'FAIL: fallback mode does not enable Vertex AI\n' >&2
    failures=$((failures + 1))
  fi

  write_test_state "vertex_ai"
  services="$(required_cloud_services)"
  if ! grep -q 'secretmanager.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Vertex-only mode lacks private bootstrap handoff\n' >&2
    failures=$((failures + 1))
  fi
  if ! grep -q 'aiplatform.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Vertex-only mode does not enable Vertex AI\n' >&2
    failures=$((failures + 1))
  fi

  actual="$(build_bootstrap_parameters \
    'projects/test-project-123/secrets/bootstrap/versions/1')"
  if ! jq -e '
    length == 1 and
    (.[0] | keys) == ["bootstrapSecretVersion"]
  ' <<<"${actual}" >/dev/null; then
    printf 'FAIL: private bootstrap values are serialized into clasp arguments\n' >&2
    failures=$((failures + 1))
  fi
}

test_secret_input_assignment() {
  local actual=""

  write_test_state "gemini_api"
  GDUC_GEMINI_API_KEY="test-secret"
  read_gemini_key actual
  unset GDUC_GEMINI_API_KEY
  assert_equal "test-secret" "${actual}" \
    "return a Gemini key to the caller without logging it"
}

test_saved_oauth_client_discovery() {
  local config_home
  local actual

  config_home="$(mktemp -d)"
  mkdir -p "${config_home}/gduc"
  printf '%s\n' '{}' >"${config_home}/gduc/ci-deployment-oauth.json"
  XDG_CONFIG_HOME="${config_home}"
  actual="$(find_saved_oauth_client)"
  unset XDG_CONFIG_HOME
  assert_equal \
    "${config_home}/gduc/ci-deployment-oauth.json" \
    "${actual}" \
    "discover the saved GDUC OAuth client"
  rm -rf "${config_home}"
}

test_reauthorize_argument() {
  MODE="install"
  parse_arguments --reauthorize
  assert_equal "reauthorize" "${MODE}" \
    "accept the explicit clasp reauthorization mode"
}

test_bootstrap_payload_keeps_key_off_disk() {
  local payload_root
  local test_status

  payload_root="$(mktemp -d)"
  set +e
  PAYLOAD_TEST_ROOT="${payload_root}" bash -c '
    source "$1"
    PROJECT_ROOT="${PAYLOAD_TEST_ROOT}"
    STATE_DIR="${PROJECT_ROOT}/state"
    STATE_FILE="${STATE_DIR}/state.json"
    INSTALL_LOCK_HELD=0
    TEMP_PATHS=()
    mkdir -p "${STATE_DIR}"
    printf "%s\n" \
      "{\"projectId\":\"test-project-123\",\"rootFolderId\":\"folder-id\",\"spreadsheetId\":\"\",\"spreadsheetTitle\":\"Utilities\",\"notificationRecipient\":\"operator@example.com\",\"geminiBackend\":\"gemini_api\",\"geminiModel\":\"gemini-2.5-flash\",\"geminiAutoVertexFallback\":false,\"vertexAiLocation\":\"global\",\"timeZone\":\"Europe/Rome\"}" \
      >"${STATE_FILE}"
    printf "%s\n" "{\"locale\":\"en\",\"time_zone\":\"Pacific/Auckland\"}" \
      >"${PROJECT_ROOT}/config.local.json"
    printf "%s\n" "Policy" >"${PROJECT_ROOT}/AGENTS.example.md"

    actual_payload=""
    build_bootstrap_payload "test-secret" actual_payload
    jq -e ".geminiApiKey == \"test-secret\" and
      .timeZone == \"Europe/Rome\" and
      .automationConfig.time_zone == \"Europe/Rome\"" \
      <<<"${actual_payload}" >/dev/null &&
      [[ "${#TEMP_PATHS[@]}" -eq 0 ]] &&
      ! grep -R -q "test-secret" "${PROJECT_ROOT}"
  ' _ "${PROJECT_ROOT}/scripts/install.sh"
  test_status=$?
  set -e
  if [[ "${test_status}" -ne 0 ]]; then
    printf 'FAIL: bootstrap key was written to installer files\n' >&2
    failures=$((failures + 1))
  fi
  rm -rf "${payload_root}"
}

test_resume_runtime_overrides() {
  local actual

  write_test_state "gemini_api_with_vertex_fallback"
  GDUC_GEMINI_MODEL="gemini-2.5-flash-lite"
  GDUC_VERTEX_AI_LOCATION="europe-west1"
  GDUC_TIME_ZONE="Pacific/Auckland"
  apply_resume_overrides
  unset GDUC_GEMINI_MODEL GDUC_TIME_ZONE GDUC_VERTEX_AI_LOCATION

  actual="$(state_get '.geminiModel')"
  assert_equal "gemini-2.5-flash-lite" "${actual}" \
    "override the pending Gemini model on resume"
  actual="$(state_get '.vertexAiLocation')"
  assert_equal "europe-west1" "${actual}" \
    "override the pending Vertex location on resume"
  actual="$(state_get '.timeZone')"
  assert_equal "Pacific/Auckland" "${actual}" \
    "temporarily override the pending IANA time zone on resume"
}

test_resume_time_zone_cannot_diverge_from_deployed_source() {
  local test_status

  write_test_state "gemini_api"
  state_set "deploymentId" "deployment-1"
  state_set "sourceTimeZone" "Europe/Rome"
  set +e
  (
    GDUC_TIME_ZONE="Pacific/Auckland"
    apply_resume_overrides
  ) >/dev/null 2>&1
  test_status=$?
  set -e
  if [[ "${test_status}" -eq 0 ]]; then
    printf 'FAIL: resume accepted a timezone different from deployed source\n' >&2
    failures=$((failures + 1))
  fi
  state_set "sourceTimeZone" ""
  set +e
  (
    GDUC_TIME_ZONE="Europe/Rome"
    apply_resume_overrides
  ) >/dev/null 2>&1
  test_status=$?
  set -e
  if [[ "${test_status}" -eq 0 ]]; then
    printf 'FAIL: legacy deployment state bypassed source timezone guard\n' >&2
    failures=$((failures + 1))
  fi
  state_set "sourceTimeZone" "Europe/Rome"
  GDUC_TIME_ZONE="Europe/Rome"
  assert_success "resume accepts the deployed source timezone" \
    apply_resume_overrides
  unset GDUC_TIME_ZONE
}

# Invoked indirectly by the rejected-credential cleanup test.
# shellcheck disable=SC2329
record_removed_secret() {
  printf '%s\n' "$1" >"${TEST_STATE_DIR}/removed-secret"
}

test_exit_zero_gemini_error_cleanup() {
  local actual

  (
    remove_bootstrap_transfer_secret() {
      record_removed_secret "$1"
    }
    discard_rejected_bootstrap_if_needed \
      '{"error":{"message":"Gemini Developer API key or model validation failed (HTTP 403)."}}' \
      'projects/test/secrets/transfer/versions/1'
  ) >/dev/null 2>&1

  actual="$(<"${TEST_STATE_DIR}/removed-secret")"
  assert_equal \
    "projects/test/secrets/transfer/versions/1" \
    "${actual}" \
    "discard a rejected Gemini key when clasp reports an exit-zero JSON error"
}

# Invoked indirectly by the secret-collision test helper.
# shellcheck disable=SC2317,SC2329
describe_unowned_secret() {
  printf '%s\n' "unrelated_owner"
}

# Invoked indirectly by the secret-collision test helper.
# shellcheck disable=SC2317,SC2329
describe_owned_secret() {
  printf '%s\n' "gduc_installer"
}

# Invoked indirectly through the assertion helpers.
# shellcheck disable=SC2317,SC2329
validate_secret_collision() {
  local describe_function="$1"

  (
    gcloud() {
      "${describe_function}"
    }
    ensure_bootstrap_transfer_secret \
      "test-project-123" \
      "drive-utilities-cataloger-test-script-id"
  ) >/dev/null 2>&1
}

test_secret_resource_ownership() {
  local actual

  write_test_state "gemini_api"
  state_set "scriptId" "test-script-id"
  actual="$(bootstrap_transfer_secret_id)"
  assert_equal \
    "drive-utilities-cataloger-test-script-id" \
    "${actual}" \
    "namespace the bootstrap secret with the Apps Script ID"

  assert_failure "reject an existing unowned bootstrap secret" \
    validate_secret_collision describe_unowned_secret
  assert_success "reuse an installer-owned bootstrap secret" \
    validate_secret_collision describe_owned_secret
}

test_installer_lock_exclusion() {
  local lock_state_dir
  local test_status

  lock_state_dir="$(mktemp -d)"
  set +e
  (
    CUSTOM_STATE_DIR_REQUESTED=1
    STATE_DIR="${lock_state_dir}"
    STATE_FILE="${STATE_DIR}/state.json"
    AUTH_DIR="${STATE_DIR}/clasp-auth"
    MANAGEMENT_AUTH_DIR="${STATE_DIR}/clasp-management-auth"
    STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
    INSTALL_LOCK_DIR="${STATE_DIR}/installer.lock"
    validate_state_directory_setting
    acquire_installer_lock
    if GDUC_STATE_DIR="${lock_state_dir}" bash -c '
      source "$1"
      validate_state_directory_setting
      acquire_installer_lock
    ' _ "${PROJECT_ROOT}/scripts/install.sh" >/dev/null 2>&1; then
      exit 1
    fi
    release_installer_lock
  )
  test_status=$?
  set -e
  if [[ "${test_status}" -ne 0 ]]; then
    printf 'FAIL: concurrent installer acquired the same state lock\n' >&2
    failures=$((failures + 1))
  fi
  rm -rf "${lock_state_dir}"
}

test_preflight_does_not_require_global_clasp_login() {
  local check_state_dir
  local test_status

  check_state_dir="$(mktemp -d)"
  set +e
  (
    MANAGEMENT_AUTH_DIR="${check_state_dir}/clasp-management-auth"
    CLASP=(false)
    check_clasp_readiness >/dev/null
  )
  test_status=$?
  set -e
  if [[ "${test_status}" -ne 0 ]]; then
    printf 'FAIL: preflight required a global clasp login\n' >&2
    failures=$((failures + 1))
  fi
  rm -rf "${check_state_dir}"
}

test_reset_removes_private_state_after_releasing_lock() {
  local reset_root
  local test_status

  reset_root="$(mktemp -d)"
  set +e
  RESET_TEST_ROOT="${reset_root}" bash -c '
    source "$1"
    PROJECT_ROOT="${RESET_TEST_ROOT}"
    STATE_DIR="${PROJECT_ROOT}/state"
    STATE_FILE="${STATE_DIR}/state.json"
    AUTH_DIR="${STATE_DIR}/clasp-auth"
    MANAGEMENT_AUTH_DIR="${STATE_DIR}/clasp-management-auth"
    STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
    INSTALL_LOCK_DIR="${STATE_DIR}/installer.lock"
    INSTALL_LOCK_HELD=0
    CONFIRM_RESULT=0
    ensure_state_directory
    printf "{}\n" >"${STATE_FILE}"
    printf "{}\n" >"${PROJECT_ROOT}/.clasp.json"
    acquire_installer_lock
    confirm() {
      CONFIRM_RESULT=1
    }
    reset_installer_state >/dev/null
    [[ ! -e "${STATE_DIR}" && ! -e "${PROJECT_ROOT}/.clasp.json" ]]
  ' _ "${PROJECT_ROOT}/scripts/install.sh"
  test_status=$?
  set -e
  if [[ "${test_status}" -ne 0 ]]; then
    printf 'FAIL: reset left private installer state behind\n' >&2
    failures=$((failures + 1))
  fi
  rm -rf "${reset_root}"
}

test_private_artifacts_are_ignored() {
  local candidate

  for candidate in \
    ".clasp.json.tmp.interrupted" \
    "config.local.json.tmp.interrupted" \
    "client_secret_example.json" \
    "oauth-client.json"; do
    if ! git -C "${PROJECT_ROOT}" check-ignore -q "${candidate}"; then
      printf 'FAIL: private artifact is not ignored: %s\n' \
        "${candidate}" >&2
      failures=$((failures + 1))
    fi
  done
}

test_restrictive_installer_umask() {
  if ! grep -Eq '^umask 077$' "${PROJECT_ROOT}/scripts/install.sh"; then
    fail "installer must create private artifacts under umask 077"
  fi
}

deployment_fixture() {
  local script_id="$1"
  local entry_point_type="$2"
  local access="$3"

  jq -cn \
    --arg script_id "${script_id}" \
    --arg entry_point_type "${entry_point_type}" \
    --arg access "${access}" '
      {
        deploymentId: "deployment-1",
        deploymentConfig: {
          scriptId: $script_id,
          versionNumber: 4,
          manifestFileName: "appsscript"
        },
        entryPoints: [{
          entryPointType: $entry_point_type,
          executionApi: {entryPointConfig: {access: $access}}
        }]
      }
    '
}

test_owner_only_api_deployment_validation() {
  local mixed_public
  local missing_entry
  local wrong_access
  local wrong_manifest
  local valid

  valid="$(deployment_fixture "test-script" "EXECUTION_API" "MYSELF")"
  missing_entry="$(deployment_fixture "test-script" "WEB_APP" "MYSELF")"
  wrong_access="$(deployment_fixture "test-script" "EXECUTION_API" "ANYONE")"
  wrong_manifest="$(jq -c \
    '.deploymentConfig.manifestFileName = "other"' <<<"${valid}")"
  mixed_public="$(jq -c '.entryPoints += [{
    entryPointType: "WEB_APP",
    webApp: {
      entryPointConfig: {
        access: "ANYONE",
        executeAs: "USER_DEPLOYING"
      }
    }
  }]' <<<"${valid}")"
  assert_success "accept an owner-only API executable" \
    validate_owner_only_api_deployment \
    "${valid}" "test-script" "deployment-1" "4"
  assert_failure "reject a deployment from another script" \
    validate_owner_only_api_deployment \
    "${valid}" "other-script" "deployment-1"
  assert_failure "reject a deployment without EXECUTION_API" \
    validate_owner_only_api_deployment \
    "${missing_entry}" \
    "test-script" "deployment-1"
  assert_failure "reject an API executable not restricted to MYSELF" \
    validate_owner_only_api_deployment \
    "${wrong_access}" \
    "test-script" "deployment-1"
  assert_failure "reject an unexpected manifest file" \
    validate_owner_only_api_deployment \
    "${wrong_manifest}" "test-script" "deployment-1"
  assert_failure "reject a mixed deployment with a public web app" \
    validate_owner_only_api_deployment \
    "${mixed_public}" "test-script" "deployment-1"
}

test_owner_only_deployment_discovery_requires_unique_identity() {
  local result=""
  local status

  set +e
  (
    run_apps_script_clasp_json() {
      printf -v "$2" '%s' '[
        {"deploymentId":"deployment-1"},
        {"deploymentId":"deployment-2"}
      ]'
    }
    read_apps_script_deployment() {
      local deployment_id="$3"
      local response_json

      response_json="$(jq -cn --arg deployment_id "${deployment_id}" '
        {
          deploymentId: $deployment_id,
          deploymentConfig: {
            scriptId: "test-script",
            versionNumber: 4,
            manifestFileName: "appsscript"
          },
          entryPoints: [{
            entryPointType: "EXECUTION_API",
            executionApi: {entryPointConfig: {access: "MYSELF"}}
          }]
        }
      ')"
      printf -v "$4" '%s' "${response_json}"
    }
    find_owner_only_api_deployment "/tmp/auth.json" "test-script" result
  )
  status=$?
  set -e
  if [[ "${status}" -eq 0 || -n "${result}" ]]; then
    printf 'FAIL: ambiguous owner-only deployment discovery did not fail closed\n' >&2
    failures=$((failures + 1))
  fi
}

test_invalid_stored_deployment_is_not_recreated() {
  local activity_log="${TEST_STATE_DIR}/stored-deployment-activity"
  local test_status

  : >"${activity_log}"
  set +e
  (
    local invalid_deployment

    invalid_deployment="$(deployment_fixture \
      "test-script" "EXECUTION_API" "ANYONE")"
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '%s\n' "deployment-1" ;;
        *) return 1 ;;
      esac
    }
    read_apps_script_deployment() {
      printf -v "$4" '%s' "${invalid_deployment}"
    }
    state_set() {
      printf 'state-set %s\n' "$1" >>"${activity_log}"
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_must_not_run() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      return 99
    }
    CLASP=(clasp_must_not_run)
    ensure_api_executable_deployment
  ) >/dev/null 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -eq 0 || -s "${activity_log}" ]]; then
    printf 'FAIL: invalid stored deployment was accepted or replaced\n' >&2
    failures=$((failures + 1))
  fi
}

test_invalid_new_deployment_is_stored_for_safe_resume() {
  local activity_log="${TEST_STATE_DIR}/new-deployment-activity"
  local deploy_count
  local retained_id
  local state_set_count
  local state_file="${TEST_STATE_DIR}/new-deployment-state"
  local test_status

  : >"${activity_log}"
  : >"${state_file}"
  set +e
  (
    local invalid_deployment
    local first_status
    local second_status

    invalid_deployment="$(deployment_fixture \
      "test-script" "WEB_APP" "MYSELF")"
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) cat "${state_file}" ;;
        .deploymentCreationDescription)
          printf '%s\n' "Owner-only installer bootstrap test-marker"
          ;;
        *) return 1 ;;
      esac
    }
    read_apps_script_deployment() {
      printf -v "$4" '%s' "${invalid_deployment}"
    }
    state_set() {
      if [[ "$1" != "deploymentId" || "$2" != "deployment-1" ]]; then
        printf 'invalid-state-set %s %s\n' "$1" "$2" >>"${activity_log}"
        return 98
      fi
      printf '%s\n' "$2" >"${state_file}"
      printf 'state-set %s %s\n' "$1" "$2" >>"${activity_log}"
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_fixture() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      case "$*" in
        "-A ${TEST_STATE_DIR}/clasp-auth/.clasprc.json --json deployments")
          printf '%s\n' '[]'
          ;;
        "-A ${TEST_STATE_DIR}/clasp-auth/.clasprc.json --json deploy --description Owner-only installer bootstrap test-marker")
          printf '%s\n' '{"deploymentId":"deployment-1"}'
          ;;
        *) return 97 ;;
      esac
    }
    CLASP=(clasp_fixture)
    (ensure_api_executable_deployment)
    first_status=$?
    (ensure_api_executable_deployment)
    second_status=$?
    [[ "${first_status}" -ne 0 && "${second_status}" -ne 0 ]]
  ) >/dev/null 2>&1
  test_status=$?
  set -e
  retained_id="$(<"${state_file}")"
  deploy_count="$(awk '/^clasp .* --json deploy / {count++} END {print count + 0}' \
    "${activity_log}")"
  state_set_count="$(awk \
    '/^state-set deploymentId deployment-1$/ {count++} END {print count + 0}' \
    "${activity_log}")"

  if [[ "${test_status}" -ne 0 ]] ||
    [[ "${retained_id}" != "deployment-1" ]] ||
    [[ "${deploy_count}" -ne 1 ]] ||
    [[ "${state_set_count}" -ne 1 ]] ||
    grep -q '^invalid-state-set' "${activity_log}"; then
    printf 'FAIL: invalid new deployment was not retained for safe resume\n' >&2
    failures=$((failures + 1))
  fi
}

test_pending_deployment_creation_is_reconciled_without_duplicate() {
  local activity_log="${TEST_STATE_DIR}/pending-deployment-activity"
  local test_status

  : >"${activity_log}"
  set +e
  (
    local valid_deployment

    valid_deployment="$(deployment_fixture \
      "test-script" "EXECUTION_API" "MYSELF")"
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '\n' ;;
        .deploymentCreationDescription)
          printf '%s\n' "Owner-only installer bootstrap test-marker"
          ;;
        *) return 1 ;;
      esac
    }
    state_set() {
      printf 'state-set %s %s\n' "$1" "$2" >>"${activity_log}"
    }
    read_apps_script_deployment() {
      [[ "$3" == "deployment-1" ]] || return 96
      printf -v "$4" '%s' "${valid_deployment}"
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_fixture() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      if [[ "$*" != \
        "-A ${TEST_STATE_DIR}/clasp-auth/.clasprc.json --json deployments" ]]; then
        return 97
      fi
      jq -cn '[{
        deploymentId: "deployment-1",
        description: "Owner-only installer bootstrap test-marker"
      }]'
    }
    CLASP=(clasp_fixture)
    ensure_api_executable_deployment
  ) >/dev/null 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -ne 0 ]] ||
    grep -q -- '--json deploy --description' "${activity_log}" ||
    ! grep -qx 'state-set deploymentId deployment-1' "${activity_log}"; then
    printf 'FAIL: pending deployment creation was not reconciled safely\n' >&2
    failures=$((failures + 1))
  fi
}

test_ambiguous_pending_deployment_creation_fails_closed() {
  local activity_log="${TEST_STATE_DIR}/ambiguous-deployment-activity"
  local test_status

  : >"${activity_log}"
  set +e
  (
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '\n' ;;
        .deploymentCreationDescription)
          printf '%s\n' "Owner-only installer bootstrap test-marker"
          ;;
        *) return 1 ;;
      esac
    }
    state_set() {
      printf 'state-set %s %s\n' "$1" "$2" >>"${activity_log}"
    }
    read_apps_script_deployment() {
      printf '%s\n' "unexpected-read" >>"${activity_log}"
      return 96
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_fixture() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      jq -cn '["deployment-1", "deployment-2"] | map({
        deploymentId: .,
        description: "Owner-only installer bootstrap test-marker"
      })'
    }
    CLASP=(clasp_fixture)
    ensure_api_executable_deployment
  ) >/dev/null 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -eq 0 ]] ||
    grep -q -- '--json deploy --description' "${activity_log}" ||
    grep -q '^state-set deploymentId' "${activity_log}" ||
    grep -q '^unexpected-read$' "${activity_log}"; then
    printf 'FAIL: ambiguous pending deployments did not fail closed\n' >&2
    failures=$((failures + 1))
  fi
}

test_valid_stored_deployment_skips_source_push() {
  local activity_log="${TEST_STATE_DIR}/valid-deployment-resume-activity"

  : >"${activity_log}"
  (
    local valid_deployment

    valid_deployment="$(deployment_fixture \
      "test-script" "EXECUTION_API" "MYSELF")"
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '%s\n' "deployment-1" ;;
        *) return 1 ;;
      esac
    }
    read_apps_script_deployment() {
      printf -v "$4" '%s' "${valid_deployment}"
    }
    push_apps_script_source() {
      printf '%s\n' "push" >>"${activity_log}"
    }
    prepare_apps_script_source_and_deployment
  ) >/dev/null 2>&1

  if [[ -s "${activity_log}" ]]; then
    printf 'FAIL: valid stored deployment caused a source push on resume\n' >&2
    failures=$((failures + 1))
  fi
}

test_invalid_stored_deployment_blocks_source_push() {
  local activity_log="${TEST_STATE_DIR}/deployment-preflight-activity"
  local test_status

  : >"${activity_log}"
  set +e
  (
    local invalid_deployment

    invalid_deployment="$(deployment_fixture \
      "test-script" "EXECUTION_API" "ANYONE")"
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '%s\n' "deployment-1" ;;
        *) return 1 ;;
      esac
    }
    read_apps_script_deployment() {
      printf -v "$4" '%s' "${invalid_deployment}"
    }
    push_apps_script_source() {
      printf '%s\n' "push" >>"${activity_log}"
    }
    prepare_apps_script_source_and_deployment
  ) >/dev/null 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -eq 0 || -s "${activity_log}" ]]; then
    printf 'FAIL: invalid stored deployment did not block source push\n' >&2
    failures=$((failures + 1))
  fi
}

test_invalid_authorization_blocks_pending_deployment_creation() {
  local activity_log="${TEST_STATE_DIR}/invalid-authorization-pending-deployment-activity"
  local output_file="${TEST_STATE_DIR}/invalid-authorization-pending-deployment-output"
  local test_status

  : >"${activity_log}"
  set +e
  (
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '\n' ;;
        .deploymentCreationDescription)
          printf '%s\n' "Owner-only installer bootstrap test-marker"
          ;;
        *) return 1 ;;
      esac
    }
    state_set() {
      printf 'state-set %s %s\n' "$1" "$2" >>"${activity_log}"
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_fixture() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      printf '%s\n' 'invalid_grant' >&2
      return 9
    }
    CLASP=(clasp_fixture)
    ensure_api_executable_deployment
  ) >"${output_file}" 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -eq 0 ]] ||
    grep -q -- '--json deploy --description' "${activity_log}" ||
    grep -q '^state-set deploymentId' "${activity_log}" ||
    ! grep -q 'OAuth refresh token is invalid or expired' "${output_file}"; then
    printf 'FAIL: invalid authorization did not block pending deployment creation\n' >&2
    failures=$((failures + 1))
  fi
}

test_invalid_authorization_blocks_new_deployment_creation() {
  local activity_log="${TEST_STATE_DIR}/invalid-authorization-new-deployment-activity"
  local output_file="${TEST_STATE_DIR}/invalid-authorization-new-deployment-output"
  local test_status

  : >"${activity_log}"
  set +e
  (
    state_get() {
      case "$1" in
        .scriptId) printf '%s\n' "test-script" ;;
        .deploymentId) printf '\n' ;;
        .deploymentCreationDescription)
          printf '%s\n' "Owner-only installer bootstrap test-marker"
          ;;
        *) return 1 ;;
      esac
    }
    state_set() {
      printf 'state-set %s %s\n' "$1" "$2" >>"${activity_log}"
    }
    read_apps_script_deployment() {
      printf '%s\n' 'unexpected-read' >>"${activity_log}"
      return 96
    }
    # Invoked indirectly through the CLASP command array.
    # shellcheck disable=SC2329
    clasp_fixture() {
      printf 'clasp %s\n' "$*" >>"${activity_log}"
      case "$*" in
        "-A ${TEST_STATE_DIR}/clasp-auth/.clasprc.json --json deployments")
          printf '%s\n' '[]'
          ;;
        "-A ${TEST_STATE_DIR}/clasp-auth/.clasprc.json --json deploy --description Owner-only installer bootstrap test-marker")
          printf '%s\n' 'invalid_grant' >&2
          return 9
          ;;
        *) return 97 ;;
      esac
    }
    CLASP=(clasp_fixture)
    ensure_api_executable_deployment
  ) >"${output_file}" 2>&1
  test_status=$?
  set -e

  if [[ "${test_status}" -eq 0 ]] ||
    ! grep -q -- '--json deploy --description' "${activity_log}" ||
    grep -q '^state-set deploymentId' "${activity_log}" ||
    grep -q '^unexpected-read$' "${activity_log}" ||
    ! grep -q 'OAuth refresh token is invalid or expired' "${output_file}"; then
    printf 'FAIL: invalid authorization did not block new deployment creation\n' >&2
    failures=$((failures + 1))
  fi
}

test_drive_id_extraction
test_input_validation
test_saved_oauth_client_discovery
test_reauthorize_argument
test_version_parsing
test_noninteractive_optional_input
test_custom_state_directory_safety
test_runtime_service_selection
test_secret_input_assignment
test_bootstrap_payload_keeps_key_off_disk
test_resume_runtime_overrides
test_resume_time_zone_cannot_diverge_from_deployed_source
test_exit_zero_gemini_error_cleanup
test_secret_resource_ownership
test_installer_lock_exclusion
test_preflight_does_not_require_global_clasp_login
test_reset_removes_private_state_after_releasing_lock
test_private_artifacts_are_ignored
test_restrictive_installer_umask
test_owner_only_api_deployment_validation
test_owner_only_deployment_discovery_requires_unique_identity
test_invalid_stored_deployment_is_not_recreated
test_invalid_new_deployment_is_stored_for_safe_resume
test_invalid_stored_deployment_blocks_source_push
test_invalid_authorization_blocks_pending_deployment_creation
test_invalid_authorization_blocks_new_deployment_creation
test_pending_deployment_creation_is_reconciled_without_duplicate
test_ambiguous_pending_deployment_creation_fails_closed
test_valid_stored_deployment_skips_source_push

if ! bash "${PROJECT_ROOT}/scripts/install.sh" --help >/dev/null; then
  printf 'FAIL: installer help is unavailable\n' >&2
  failures=$((failures + 1))
fi

if ! make -C "${PROJECT_ROOT}" --no-print-directory |
  grep -q "install-resume"; then
  printf 'FAIL: default make target does not print installer help\n' >&2
  failures=$((failures + 1))
fi

if ! make -C "${PROJECT_ROOT}" --no-print-directory |
  grep -q "install-reconfigure-time-zone"; then
  printf 'FAIL: make help omits time-zone reconfiguration\n' >&2
  failures=$((failures + 1))
fi

if [[ "${failures}" -ne 0 ]]; then
  printf '%s installer test(s) failed.\n' "${failures}" >&2
  exit 1
fi

printf 'Installer helper tests passed.\n'
exit 0
