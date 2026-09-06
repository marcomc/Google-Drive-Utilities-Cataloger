#!/usr/bin/env bash

# Test fixtures deliberately define globals and callbacks consumed indirectly by
# the sourced installer; ShellCheck cannot trace those runtime references.
# shellcheck disable=SC1091,SC2034,SC2329

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_STATE_DIR="$(mktemp -d)"
export GDUC_STATE_DIR="${TEST_STATE_DIR}"

# shellcheck source=scripts/install.sh
source "${PROJECT_ROOT}/scripts/install.sh"
TEMP_PATHS+=("${TEST_STATE_DIR}")
TEST_SCRIPT_DIR="${PROJECT_ROOT}/scripts"
TEST_INSTALLER_VERSION="$(sed -n 's/^INSTALLER_VERSION=//p' "${TEST_SCRIPT_DIR}/install.sh")"

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
  assert_success "accept the Gemini latest Flash alias" \
    is_valid_gemini_model "gemini-flash-latest"
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

test_initial_resume_and_handoff_preserve_model_pins() {
  local requested_model
  local model_test_root
  local test_status
  model_test_root="$(mktemp -d)"
  for requested_model in "" "gemini-3.6-flash" "gemini-3.7-flash"; do
    set +e
    MODEL_TEST_ROOT="${model_test_root}" REQUESTED_MODEL="${requested_model}" bash -c '
      set -euo pipefail
      source "$1"
      expected_model="${REQUESTED_MODEL:-gemini-flash-latest}"
      actual_payload=""
      model_test_root="${MODEL_TEST_ROOT}"
      STATE_DIR="${model_test_root}/state"
      STATE_FILE="${STATE_DIR}/state.json"
      NON_INTERACTIVE=1
      GDUC_PROJECT_NAME="Test project"
      GDUC_PROJECT_ID="test-project-123"
      GDUC_ROOT_FOLDER="1AbCdEfGhIjKlMnOpQrStUvWxYz_12345"
      GDUC_GEMINI_MODEL="${REQUESTED_MODEL}"
      active_gcloud_account() { printf "%s\n" "operator@example.com"; }
      select_billing_account() { printf "%s\n" "000000-000000-000000"; }
      select_gemini_mode() { printf "%s\n" "gemini_api_with_vertex_fallback"; }
      gcloud() {
        case "$*" in
          "projects describe "*) return 1 ;;
          "billing accounts describe "*) printf "%s\n" true ;;
          *) return 99 ;;
        esac
      }
      collect_installation_inputs
      actual_model="$(state_get ".geminiModel")"
      [[ "${actual_model}" == "${expected_model}" ]]
      unset GDUC_GEMINI_MODEL
      apply_resume_overrides
      actual_model="$(state_get ".geminiModel")"
      [[ "${actual_model}" == "${expected_model}" ]]
      cp "${PROJECT_ROOT}/config.example.json" "${model_test_root}/config.local.json"
      cp "${PROJECT_ROOT}/AGENTS.example.md" "${model_test_root}/AGENTS.example.md"
      PROJECT_ROOT="${model_test_root}"
      build_bootstrap_payload "test-secret" actual_payload
      actual_model="$(jq -r ".geminiModel" <<<"${actual_payload}")"
      [[ "${actual_model}" == "${expected_model}" ]]
      for GDUC_GEMINI_MODEL in "gemini-3.6-flash" "gemini-3.7-flash"; do
        apply_resume_overrides
        actual_model="$(state_get ".geminiModel")"
        [[ "${actual_model}" == "${GDUC_GEMINI_MODEL}" ]]
        build_bootstrap_payload "test-secret" actual_payload
        actual_model="$(jq -r ".geminiModel" <<<"${actual_payload}")"
        [[ "${actual_model}" == "${GDUC_GEMINI_MODEL}" ]]
      done
    ' _ "${PROJECT_ROOT}/scripts/install.sh"
    test_status=$?
    set -e
    if [[ "${test_status}" -ne 0 ]]; then
      printf 'FAIL: installer changed model pin %s\n' "${requested_model:-default}" >&2
      failures=$((failures + 1))
    fi
  done
  rm -rf "${model_test_root}"
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
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    list_apps_script_resources() {
      printf -v "$4" '%s' '[
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

test_owner_only_deployment_discovery_rejects_list_failures() {
  local result=""
  local status

  set +e
  (
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    list_apps_script_resources() {
      return 91
    }
    find_owner_only_api_deployment "/tmp/auth.json" "test-script" result
  ) >/dev/null 2>&1
  status=$?
  set -e
  if [[ "${status}" -eq 0 || -n "${result}" ]]; then
    printf 'FAIL: failed deployment listing did not fail closed\n' >&2
    failures=$((failures + 1))
  fi
}

test_owner_only_deployment_discovery_rejects_zero_matches() {
  local result=""
  local status

  set +e
  (
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    list_apps_script_resources() {
      printf -v "$4" '%s' '[{"deploymentId":"deployment-1"}]'
    }
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    read_apps_script_deployment() {
      local response_json
      local response_status

      response_json="$(deployment_fixture \
        "test-script" "EXECUTION_API" "ANYONE")"
      response_status=$?
      if [[ "${response_status}" -ne 0 ]]; then
        return "${response_status}"
      fi
      printf -v "$4" '%s' "${response_json}"
    }
    find_owner_only_api_deployment "/tmp/auth.json" "test-script" result
  ) >/dev/null 2>&1
  status=$?
  set -e
  if [[ "${status}" -eq 0 || -n "${result}" ]]; then
    printf 'FAIL: zero matching deployments did not fail closed\n' >&2
    failures=$((failures + 1))
  fi
}

test_owner_only_deployment_discovery_selects_unique_match() {
  local actual
  local status

  set +e
  actual="$(
    (
      result=""
      # Invoked indirectly by find_owner_only_api_deployment.
      # shellcheck disable=SC2329
      list_apps_script_resources() {
        printf -v "$4" '%s' '[
          {"deploymentId":"deployment-invalid"},
          {"deploymentId":"deployment-valid"}
        ]'
      }
      # Invoked indirectly by find_owner_only_api_deployment.
      # shellcheck disable=SC2329
      read_apps_script_deployment() {
        local access="ANYONE"
        local response_json
        local response_status

        if [[ "$3" == "deployment-valid" ]]; then
          access="MYSELF"
        fi
        response_json="$(deployment_fixture \
          "test-script" "EXECUTION_API" "${access}")"
        response_status=$?
        if [[ "${response_status}" -ne 0 ]]; then
          return "${response_status}"
        fi
        response_json="$(jq -c --arg deployment_id "$3" \
          '.deploymentId = $deployment_id' <<<"${response_json}")" || return
        printf -v "$4" '%s' "${response_json}"
      }
      find_owner_only_api_deployment "/tmp/auth.json" "test-script" result
      printf '%s' "${result}"
    )
  )"
  status=$?
  set -e
  if [[ "${status}" -ne 0 || "${actual}" != "deployment-valid" ]]; then
    printf 'FAIL: unique owner-only deployment was not selected\n' >&2
    failures=$((failures + 1))
  fi
}

test_owner_only_deployment_discovery_aborts_on_inspection_failure() {
  local read_log="${TEST_STATE_DIR}/deployment-discovery-read-log"
  local result=""
  local status

  set +e
  (
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    list_apps_script_resources() {
      printf -v "$4" '%s' '[
        {"deploymentId":"deployment-valid"},
        {"deploymentId":"deployment-unreadable"}
      ]'
    }
    # Invoked indirectly by find_owner_only_api_deployment.
    # shellcheck disable=SC2329
    read_apps_script_deployment() {
      local response_json
      local response_status

      printf '%s\n' "$3" >>"${read_log}"
      if [[ "$3" == "deployment-unreadable" ]]; then
        printf '%s\n' 'simulated inspection failure' >&2
        return 92
      fi
      response_json="$(deployment_fixture \
        "test-script" "EXECUTION_API" "MYSELF")"
      response_status=$?
      if [[ "${response_status}" -ne 0 ]]; then
        return "${response_status}"
      fi
      response_json="$(jq -c --arg deployment_id "$3" \
        '.deploymentId = $deployment_id' <<<"${response_json}")" || return
      printf -v "$4" '%s' "${response_json}"
    }
    find_owner_only_api_deployment "/tmp/auth.json" "test-script" result
  ) >/dev/null 2>&1
  status=$?
  set -e
  if [[ "${status}" -eq 0 || -n "${result}" ]] ||
    [[ "$(<"${read_log}")" != $'deployment-valid\ndeployment-unreadable' ]]; then
    printf 'FAIL: unreadable deployment was treated as an ordinary nonmatch\n' >&2
    failures=$((failures + 1))
  fi
}

version_content_fixture() {
  node -e '
    const { requiredEntrypoints } = require(process.argv[1]);
    console.log(JSON.stringify({files: requiredEntrypoints
      .filter((name) => name !== process.argv[2])
      .map((name) => ({type: "SERVER_JS", source: "function " + name + "() {}"}))}));
  ' "${TEST_SCRIPT_DIR}/lib/apps-script-entrypoints.js" "${1:-}"
}

initialize_version_recovery_fixture() {
  local fixture_dir="$1" mode="$2" checkpoint initial_version=null
  mkdir -p "${fixture_dir}/project" "${fixture_dir}/state/auth"
  printf '%s\n' '{"scriptId":"test-script"}' >"${fixture_dir}/project/.clasp.json"
  printf '%s\n' '{"tokens":{"default":{"access_token":"test-token"}}}' \
    >"${fixture_dir}/state/auth/.clasprc.json"
  jq -cn --argjson installerVersion "${TEST_INSTALLER_VERSION}" '{
    installerVersion: $installerVersion, phase: "browser_required", projectId: "test-project",
    scriptId: "test-script", timeZone: "Europe/Rome", sourceTimeZone: "Europe/Rome"
  }' >"${fixture_dir}/state/state.json"
  printf '%s\n' '[]' >"${fixture_dir}/versions.json"
  printf '%s\n' '[]' >"${fixture_dir}/deployments.json"
  : >"${fixture_dir}/activity"
  if [[ "${mode}" != fresh && "${mode}" != stored ]]; then
    jq '.deploymentCreationDescription = "Owner-only installer bootstrap fixture"' \
      "${fixture_dir}/state/state.json" >"${fixture_dir}/state/initial.json"
    mv "${fixture_dir}/state/initial.json" "${fixture_dir}/state/state.json"
    jq -cn '[{scriptId:"test-script",versionNumber:4,
      description:"Owner-only installer bootstrap fixture"}]' >"${fixture_dir}/versions.json"
  fi
  if [[ "${mode}" == created || "${mode}" == deployed ]]; then initial_version=4; fi
  if [[ "${mode}" == created || "${mode}" == deployed || "${mode}" == planned ]]; then
    checkpoint="$(jq -cn --argjson version "${initial_version}" '{scriptId:"test-script",
      description:"Owner-only installer bootstrap fixture",sourceTimeZone:"Europe/Rome",versionNumber:$version}')"
    jq --arg checkpoint "${checkpoint}" '.deploymentVersionCheckpoint = $checkpoint' \
      "${fixture_dir}/state/state.json" >"${fixture_dir}/state/initial.json"
    mv "${fixture_dir}/state/initial.json" "${fixture_dir}/state/state.json"
  fi
  if [[ "${mode}" == deployed || "${mode}" == legacy-deployment || "${mode}" == stored ]]; then
    deployment_fixture test-script EXECUTION_API MYSELF |
      jq '[. | .deploymentConfig.description = "Owner-only installer bootstrap fixture"]' \
      >"${fixture_dir}/deployments.json"
  fi
  if [[ "${mode}" == deployed || "${mode}" == stored ]]; then
    jq '.deploymentId = "deployment-1"' "${fixture_dir}/state/state.json" >"${fixture_dir}/state/initial.json"
    mv "${fixture_dir}/state/initial.json" "${fixture_dir}/state/state.json"
  fi
}

run_version_recovery_turn() (
  set -e
  fixture_dir="$1"
  fixture_scenario="$2"
  missing_entrypoint="${3:-}"
  # Each fixture intentionally isolates the sourced installer project in a subshell.
  # shellcheck disable=SC2030
  PROJECT_ROOT="${fixture_dir}/project"
  STATE_DIR="${fixture_dir}/state"
  STATE_FILE="${STATE_DIR}/state.json"
  AUTH_DIR="${STATE_DIR}/auth"
  TEMP_PATHS=()
  INSTALL_LOCK_HELD=0
  trap cleanup EXIT
  CLASP=(recovery_clasp_fixture)

  push_apps_script_source() {
    printf '%s\n' push >>"${fixture_dir}/activity"
    [[ "${fixture_scenario}" != push-failure ]] || return 91
    state_set sourceTimeZone Europe/Rome
  }
  mv() {
    if [[ "${fixture_scenario}" == checkpoint-failure && "$2" == "${STATE_FILE}" ]] &&
      jq -e '.deploymentVersionCheckpoint | fromjson? | .versionNumber == 4' "$1" >/dev/null; then
      printf '%s\n' checkpoint-failed >>"${fixture_dir}/activity"
      return 92
    fi
    if [[ "${fixture_scenario}" == deployment-checkpoint-failure && "$2" == "${STATE_FILE}" ]] &&
      jq -e '.deploymentId == "deployment-1"' "$1" >/dev/null; then
      printf '%s\n' deployment-checkpoint-failed >>"${fixture_dir}/activity"
      return 92
    fi
    command mv "$@"
  }
  recovery_clasp_fixture() {
    [[ "$1" == -A && "$2" == "${AUTH_DIR}/.clasprc.json" && "$3" == --json ]] || return 93
    shift 3
    local description resource_json
    description="$(jq -r '(.deploymentVersionCheckpoint | fromjson? | .description) // .deploymentCreationDescription' "${STATE_FILE}")"
    case "$1" in
      version)
        [[ "$2" == "${description}" ]] || return 94
        if [[ "${fixture_scenario}" == version-auth ]]; then
          printf '%s\n' invalid_grant >&2
          return 9
        fi
        jq -e '.deploymentVersionCheckpoint | fromjson | .versionNumber == null' "${STATE_FILE}" >/dev/null
        printf '%s\n' version-create >>"${fixture_dir}/activity"
        jq -cn --arg description "${description}" \
          '[{scriptId:"test-script",versionNumber:4,description:$description}]' >"${fixture_dir}/versions.json"
        if [[ "${fixture_scenario}" == version-interruption ]]; then
          sh -c 'kill -TERM "$PPID"'
        fi
        printf '%s\n' '{"versionNumber":4}'
        ;;
      deploy)
        [[ "$*" == "deploy --versionNumber 4 --description ${description}" ]] || return 95
        jq -e '.deploymentVersionCheckpoint | fromjson | .versionNumber == 4' "${STATE_FILE}" >/dev/null
        if [[ "${fixture_scenario}" == deploy-failure || "${fixture_scenario}" == deploy-auth ]]; then
          printf '%s\n' deploy-failed >>"${fixture_dir}/activity"
          printf '%s\n' invalid_grant >&2
          return 9
        fi
        printf '%s\n' deployment-create >>"${fixture_dir}/activity"
        resource_json="$(deployment_fixture test-script EXECUTION_API MYSELF)"
        jq --arg description "${description}" \
          '[. | .deploymentConfig.description = $description]' <<<"${resource_json}" >"${fixture_dir}/deployments.json"
        if [[ "${fixture_scenario}" == deployment-interruption ]]; then
          sh -c 'kill -TERM "$PPID"'
        fi
        printf '%s\n' '{"deploymentId":"deployment-1","versionNumber":4}'
        ;;
      *) return 96 ;;
    esac
  }
  list_apps_script_resources() {
    [[ "$1" == "${AUTH_DIR}/.clasprc.json" && "$2" == test-script ]] || return 97
    printf 'list-%s\n' "$3" >>"${fixture_dir}/activity"
    [[ "${fixture_scenario}" != list-failure ]] || return 9
    local listed
    listed="$(cat "${fixture_dir}/$3.json")"
    printf -v "$4" '%s' "${listed}"
  }
  read_apps_script_version_content() {
    [[ "$2" == test-script && "$3" == 4 ]] || return 98
    jq -e '.deploymentVersionCheckpoint | fromjson | .versionNumber == 4' "${STATE_FILE}" >/dev/null
    printf '%s\n' content-4 >>"${fixture_dir}/activity"
    [[ "${fixture_scenario}" != content-failure ]] || return 9
    local content
    content="$(version_content_fixture "${missing_entrypoint}")"
    case "${fixture_scenario}" in
      guarded) content="$(jq '.files[0].source = ("if (false)\n" + .files[0].source)' <<<"${content}")" ;;
      malformed-source) content="$(jq '.files[0].source += "("' <<<"${content}")" ;;
      *) ;;
    esac
    printf -v "$4" '%s' "${content}"
  }
  read_apps_script_deployment() {
    [[ "$2" == test-script && "$3" == deployment-1 ]] || return 99
    printf '%s\n' metadata >>"${fixture_dir}/activity"
    if grep -q '^deployment-create$' "${fixture_dir}/activity" &&
      [[ "${fixture_scenario}" != success ]]; then
      jq -e '.deploymentId == "deployment-1"' "${STATE_FILE}" >/dev/null
    fi
    [[ "${fixture_scenario}" != metadata-failure ]] || return 9
    local metadata
    metadata="$(jq '.[0]' "${fixture_dir}/deployments.json")"
    if [[ "${fixture_scenario}" == wrong-access ]]; then
      metadata="$(jq '.entryPoints[0].executionApi.entryPointConfig.access = "ANYONE"' <<<"${metadata}")"
    elif [[ "${fixture_scenario}" == wrong-version ]]; then
      metadata="$(jq '.deploymentConfig.versionNumber = 5' <<<"${metadata}")"
    elif [[ "${fixture_scenario}" == wrong-description ]]; then
      metadata="$(jq '.deploymentConfig.description = "other-marker"' <<<"${metadata}")"
    elif [[ "${fixture_scenario}" == wrong-script ]]; then
      metadata="$(jq '.deploymentConfig.scriptId = "other-script"' <<<"${metadata}")"
    fi
    printf -v "$4" '%s' "${metadata}"
  }
  sleep() { printf '%s\n' unexpected-sleep >>"${fixture_dir}/activity"; return 99; }
  if [[ "${fixture_scenario}" == timezone-override ]]; then
    GDUC_TIME_ZONE=Pacific/Auckland
    apply_resume_overrides
  else
    prepare_apps_script_source_and_deployment
  fi
)

check_recovery_failure() {
  local fixture_dir="$1" scenario="$2" missing_api="${3:-}" status
  set +e
  run_version_recovery_turn "${fixture_dir}" "${scenario}" "${missing_api}" >"${fixture_dir}/output" 2>&1
  status=$?
  set -e
  if [[ "${status}" -eq 0 ]]; then
    printf 'FAIL: version recovery accepted %s\n' "${scenario}" >&2
    failures=$((failures + 1))
  fi
}

test_installer_version_checkpoint_recovery() {
  local mode scenario fixture_dir status version_count deployment_count push_count checkpoint
  local required_entrypoints entrypoint mutation
  required_entrypoints="$(node -e 'console.log(require(process.argv[1]).requiredEntrypoints.join("\n"))' \
    "${TEST_SCRIPT_DIR}/lib/apps-script-entrypoints.js")"
  for mode in fresh created planned legacy legacy-deployment deployed stored; do
    fixture_dir="${TEST_STATE_DIR}/recovery-${mode}"
    initialize_version_recovery_fixture "${fixture_dir}" "${mode}"
    set +e
    run_version_recovery_turn "${fixture_dir}" success >"${fixture_dir}/output" 2>&1
    status=$?
    set -e
    if [[ "${status}" != 0 ]]; then
      printf 'FAIL: %s version recovery failed\n' "${mode}" >&2
      cat "${fixture_dir}/output" >&2
      failures=$((failures + 1))
    fi
    version_count="$(grep -c '^version-create$' "${fixture_dir}/activity" || true)"
    push_count="$(grep -c '^push$' "${fixture_dir}/activity" || true)"
    deployment_count="$(grep -c '^deployment-create$' "${fixture_dir}/activity" || true)"
    if [[ "${mode}" == fresh ]]; then
      assert_equal 1 "${version_count}" 'fresh version is created once'
      assert_equal 1 "${push_count}" 'fresh source is pushed once'
    else
      assert_equal 0 "${version_count}" 'resume reuses its immutable version'
      assert_equal 0 "${push_count}" 'resume never repushes local source'
    fi
    if [[ "${mode}" == deployed || "${mode}" == legacy-deployment || "${mode}" == stored ]]; then
      assert_equal 0 "${deployment_count}" 'existing deployment is reused'
    else
      assert_equal 1 "${deployment_count}" 'missing deployment is created once'
    fi
    checkpoint="$(jq -r '.deploymentVersionCheckpoint // ""' "${fixture_dir}/state/state.json")"
    assert_equal '' "${checkpoint}" 'verified deployment clears the version checkpoint'
  done
  for scenario in content-failure deploy-failure checkpoint-failure deployment-checkpoint-failure version-interruption deployment-interruption metadata-failure; do
    fixture_dir="${TEST_STATE_DIR}/retry-${scenario}"
    initialize_version_recovery_fixture "${fixture_dir}" fresh
    check_recovery_failure "${fixture_dir}" "${scenario}"
    # The local source can change between invocations; recovery must not upload it.
    printf '%s\n' 'throw new Error("new local HEAD must not be pushed");' >"${fixture_dir}/project/Changed.gs"
    set +e
    run_version_recovery_turn "${fixture_dir}" success >>"${fixture_dir}/output" 2>&1
    status=$?
    set -e
    if [[ "${status}" != 0 ]]; then
      printf 'FAIL: %s did not recover\n' "${scenario}" >&2
      cat "${fixture_dir}/output" >&2
      failures=$((failures + 1))
    fi
    version_count="$(grep -c '^version-create$' "${fixture_dir}/activity" || true)"
    deployment_count="$(grep -c '^deployment-create$' "${fixture_dir}/activity" || true)"
    push_count="$(grep -c '^push$' "${fixture_dir}/activity" || true)"
    assert_equal 1 "${version_count}" "${scenario}: no duplicate version"
    assert_equal 1 "${deployment_count}" "${scenario}: no duplicate deployment"
    assert_equal 1 "${push_count}" "${scenario}: no repeated HEAD push"
  done
  fixture_dir="${TEST_STATE_DIR}/fresh-discovery-retry"
  initialize_version_recovery_fixture "${fixture_dir}" fresh
  check_recovery_failure "${fixture_dir}" list-failure
  if ! jq -e '(.deploymentVersionCheckpoint // "") == "" and
    (.deploymentCreationDescription // "") == ""' "${fixture_dir}/state/state.json" >/dev/null; then
    printf 'FAIL: fresh discovery failure stranded a pending creation marker\n' >&2
    failures=$((failures + 1))
  fi
  set +e
  run_version_recovery_turn "${fixture_dir}" success >>"${fixture_dir}/output" 2>&1
  status=$?
  set -e
  assert_equal 0 "${status}" 'fresh discovery failure can safely resume'
  assert_equal 1 "$(grep -c '^version-create$' "${fixture_dir}/activity" || true)" 'fresh discovery retry creates one version'
  for mode in fresh created legacy-deployment; do
    while IFS= read -r entrypoint; do
      fixture_dir="${TEST_STATE_DIR}/missing-${mode}-${entrypoint}"
      initialize_version_recovery_fixture "${fixture_dir}" "${mode}"
      check_recovery_failure "${fixture_dir}" missing "${entrypoint}"
      assert_equal 0 "$(grep -c '^deployment-create$' "${fixture_dir}/activity" || true)" 'missing API blocks promotion'
      assert_equal 1 "$(grep -c '^content-4$' "${fixture_dir}/activity" || true)" 'missing API is inspected exactly once'
    done <<<"${required_entrypoints}"
  done
  for scenario in guarded malformed-source push-failure list-failure version-auth deploy-auth wrong-access wrong-version wrong-description wrong-script timezone-override; do
    fixture_dir="${TEST_STATE_DIR}/reject-${scenario}"
    mode=created
    if [[ "${scenario}" == version-auth || "${scenario}" == push-failure ]]; then mode=fresh; fi
    if [[ "${scenario}" == wrong-* ]]; then mode=deployed; fi
    if [[ "${scenario}" == wrong-description || "${scenario}" == wrong-script ]]; then mode=legacy-deployment; fi
    initialize_version_recovery_fixture "${fixture_dir}" "${mode}"
    check_recovery_failure "${fixture_dir}" "${scenario}"
    assert_equal 0 "$(grep -c '^deployment-create$' "${fixture_dir}/activity" || true)" 'rejected recovery cannot create deployment'
    if [[ "${scenario}" == *-auth ]]; then
      if ! grep -q 'OAuth refresh token is invalid or expired' "${fixture_dir}/output"; then
        printf 'FAIL: %s lost authorization guidance\n' "${scenario}" >&2
        failures=$((failures + 1))
      fi
    fi
  done
  for mutation in '[]' '.[0:0]' '. + [.[0] | .versionNumber = 5]'; do
    fixture_dir="${TEST_STATE_DIR}/uncertain-${RANDOM}"
    initialize_version_recovery_fixture "${fixture_dir}" planned
    jq "${mutation}" "${fixture_dir}/versions.json" >"${fixture_dir}/changed.json"
    mv "${fixture_dir}/changed.json" "${fixture_dir}/versions.json"
    check_recovery_failure "${fixture_dir}" success
    assert_equal 0 "$(grep -c '^version-create$' "${fixture_dir}/activity" || true)" 'uncertain acceptance cannot create another version'
    assert_equal 0 "$(grep -c '^push$' "${fixture_dir}/activity" || true)" 'uncertain acceptance cannot repush source'
  done
  for mutation in \
    '.deploymentVersionCheckpoint = {}' \
    '.deploymentVersionCheckpoint = "not json"' \
    '.deploymentVersionCheckpoint |= (fromjson | .versionNumber = -1 | tojson)' \
    '.deploymentVersionCheckpoint |= (fromjson | .scriptId = "other" | tojson)' \
    '.deploymentVersionCheckpoint |= (fromjson | .description = "other" | tojson)' \
    '.deploymentVersionCheckpoint |= (fromjson | del(.sourceTimeZone) | tojson)' \
    '.timeZone = "Pacific/Auckland"' \
    '.phase = "script_ready"'; do
    fixture_dir="${TEST_STATE_DIR}/malformed-${RANDOM}"
    initialize_version_recovery_fixture "${fixture_dir}" created
    jq "${mutation}" "${fixture_dir}/state/state.json" >"${fixture_dir}/changed.json"
    mv "${fixture_dir}/changed.json" "${fixture_dir}/state/state.json"
    cp "${fixture_dir}/state/state.json" "${fixture_dir}/before.json"
    check_recovery_failure "${fixture_dir}" success
    assert_equal '' "$(<"${fixture_dir}/activity")" 'malformed checkpoint fails before external work'
    if ! cmp -s "${fixture_dir}/before.json" "${fixture_dir}/state/state.json"; then
      printf 'FAIL: malformed checkpoint was mutated\n' >&2
      failures=$((failures + 1))
    fi
  done
}


test_complete_apps_script_discovery() {
  local collection scenario fixture_dir status expected_reads actual_reads
  for collection in versions deployments; do
    for scenario in single multiple empty empty-first-page auth-failure missing-token transport http malformed scalar invalid-collection wrong-script invalid-number repeated-token duplicate-id page-limit invalid-token oauth-ambiguous; do
      if [[ "${scenario}" == oauth-ambiguous && "${collection}" != deployments ]]; then continue; fi
      fixture_dir="${TEST_STATE_DIR}/discovery-${collection}-${scenario}"
      mkdir -p "${fixture_dir}"
      printf '%s\n' '{"tokens":{"default":{"access_token":"private-test-token"}}}' >"${fixture_dir}/auth.json"
      : >"${fixture_dir}/reads"
      if [[ "${scenario}" == missing-token ]]; then printf '%s\n' '{}' >"${fixture_dir}/auth.json"; fi
      set +e
      (
        CLASP=(discovery_clasp_fixture)
        discovery_clasp_fixture() {
          [[ "$*" == "-A ${fixture_dir}/auth.json --json deployments" ]] || return 97
          if [[ "${scenario}" == auth-failure ]]; then
            printf '%s\n' 'invalid_grant private-provider-detail' >&2
            return 9
          fi
          # This deliberately incomplete CLI result must never select a candidate.
          printf '%s\n' '[{"deploymentId":"untrusted-cli-only-result"}]'
        }
        curl() {
          local url="$7" page_number resource page token='' header
          [[ "$#" == 7 && "$1" == --silent && "$2" == --show-error &&
            "$3" == --header && "$4" == @- && "$5" == --write-out && "$6" == $'\n%{http_code}' ]] || return 97
          IFS= read -r header
          [[ "${header}" == 'Authorization: Bearer private-test-token' ]] || return 98
          [[ "${url}" == "https://script.googleapis.com/v1/projects/test-script/${collection}?pageSize=100"* ]] || return 99
          page_number="$(wc -l <"${fixture_dir}/reads" | tr -d ' ')"
          page_number=$((page_number + 1))
          if [[ "${page_number}" == 2 && "${scenario}" != page-limit ]]; then
            [[ "${url}" == *'&pageToken=page%2F2%20%3F' ]] || return 96
          fi
          printf '%s\n' "${url}" >>"${fixture_dir}/reads"
          case "${scenario}" in
            transport) printf '%s\n' private-provider-detail >&2; return 28 ;;
            http) printf '%s\n403' '{"error":"private-provider-detail"}'; return 0 ;;
            malformed) printf '%s\n200' '{private-provider-detail'; return 0 ;;
            empty) printf '%s\n200' '{}'; return 0 ;;
            *) ;;
          esac
          if [[ "${collection}" == versions ]]; then
            resource="$(jq -cn --argjson version "$((page_number + 3))" \
              '{scriptId:"test-script",versionNumber:$version,description:"fixture"}')"
          else
            resource="$(deployment_fixture test-script EXECUTION_API MYSELF)"
            resource="$(jq --arg id "deployment-${page_number}" '.deploymentId = $id' <<<"${resource}")"
          fi
          case "${scenario}" in
            scalar) resource=7 ;;
            invalid-number)
              if [[ "${collection}" == versions ]]; then
                resource="$(jq '.versionNumber = 0' <<<"${resource}")"
              else
                resource="$(jq '.deploymentConfig.versionNumber = 0' <<<"${resource}")"
              fi
              ;;
            wrong-script)
              if [[ "${page_number}" == 2 ]]; then
                if [[ "${collection}" == versions ]]; then
                  resource="$(jq '.scriptId = "other-script"' <<<"${resource}")"
                else
                  resource="$(jq '.deploymentConfig.scriptId = "other-script"' <<<"${resource}")"
                fi
              fi
              ;;
            duplicate-id)
              if [[ "${collection}" == versions ]]; then
                resource="$(jq '.versionNumber = 4' <<<"${resource}")"
              else
                resource="$(jq '.deploymentId = "deployment-1"' <<<"${resource}")"
              fi
              ;;
            *) ;;
          esac
          if [[ "${page_number}" == 1 && "${scenario}" =~ ^(multiple|empty-first-page|wrong-script|duplicate-id|oauth-ambiguous|repeated-token)$ ]]; then
            token='page/2 ?'
          elif [[ "${scenario}" == repeated-token ]]; then
            token='page/2 ?'
          elif [[ "${scenario}" == page-limit ]]; then
            token="next-${page_number}"
          fi
          page="$(jq -cn --arg collection "${collection}" --argjson resource "${resource}" \
            --arg token "${token}" '{($collection):[$resource]} +
              (if $token == "" then {} else {nextPageToken:$token} end)')"
          if [[ "${scenario}" == empty-first-page && "${page_number}" == 1 ]]; then
            page="$(jq --arg collection "${collection}" 'del(.[$collection])' <<<"${page}")"
          elif [[ "${scenario}" == invalid-collection ]]; then
            page="$(jq --arg collection "${collection}" '.[$collection] = null' <<<"${page}")"
          elif [[ "${scenario}" == invalid-token ]]; then
            page="$(jq '.nextPageToken = 42' <<<"${page}")"
          fi
          printf '%s\n200' "${page}"
        }
        read_apps_script_deployment() {
          local metadata
          printf '%s\n' "$3" >>"${fixture_dir}/metadata"
          metadata="$(deployment_fixture test-script EXECUTION_API MYSELF)"
          metadata="$(jq --arg id "$3" '.deploymentId = $id' <<<"${metadata}")"
          printf -v "$4" '%s' "${metadata}"
        }
        result=sentinel
        if [[ "${scenario}" == oauth-ambiguous ]]; then
          find_owner_only_api_deployment "${fixture_dir}/auth.json" test-script result
        else
          list_apps_script_resources "${fixture_dir}/auth.json" test-script "${collection}" result
        fi
        status=$?
        printf '%s' "${result}" >"${fixture_dir}/result"
        exit "${status}"
      ) >"${fixture_dir}/output" 2>&1
      status=$?
      set -e
      expected_reads=1
      case "${scenario}" in
        auth-failure|missing-token) expected_reads=0 ;;
        multiple|empty-first-page|wrong-script|duplicate-id|oauth-ambiguous|repeated-token) expected_reads=2 ;;
        page-limit) expected_reads=10 ;;
        *) ;;
      esac
      actual_reads="$(wc -l <"${fixture_dir}/reads" | tr -d ' ')"
      assert_equal "${expected_reads}" "${actual_reads}" "${collection}/${scenario}: exact page reads"
      if [[ "${scenario}" =~ ^(single|multiple|empty|empty-first-page)$ ]]; then
        if [[ "${status}" -ne 0 ]]; then
          printf 'FAIL: complete %s/%s discovery failed\n' "${collection}" "${scenario}" >&2
          cat "${fixture_dir}/output" >&2
          failures=$((failures + 1))
        fi
      else
        if [[ "${status}" -eq 0 || "$(<"${fixture_dir}/result")" != sentinel ]]; then
          printf 'FAIL: incomplete or invalid %s/%s discovery was published\n' "${collection}" "${scenario}" >&2
          failures=$((failures + 1))
        fi
      fi
      if grep -q 'private-provider-detail\|private-test-token' "${fixture_dir}/output"; then
        printf 'FAIL: discovery leaked provider detail or authorization\n' >&2
        failures=$((failures + 1))
      fi
      if [[ "${scenario}" == oauth-ambiguous ]]; then
        assert_equal $'deployment-1\ndeployment-2' "$(<"${fixture_dir}/metadata")" \
          'OAuth adoption inspects the later-page second owner deployment'
      fi
    done
  done
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
test_initial_resume_and_handoff_preserve_model_pins
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
test_owner_only_deployment_discovery_rejects_list_failures
test_owner_only_deployment_discovery_rejects_zero_matches
test_owner_only_deployment_discovery_selects_unique_match
test_owner_only_deployment_discovery_aborts_on_inspection_failure
test_installer_version_checkpoint_recovery
test_complete_apps_script_discovery

if ! bash "${TEST_SCRIPT_DIR}/install.sh" --help >/dev/null; then
  printf 'FAIL: installer help is unavailable\n' >&2
  failures=$((failures + 1))
fi

if ! make -C "${TEST_SCRIPT_DIR}/.." --no-print-directory |
  grep -q "install-resume"; then
  printf 'FAIL: default make target does not print installer help\n' >&2
  failures=$((failures + 1))
fi

if ! make -C "${TEST_SCRIPT_DIR}/.." --no-print-directory |
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
