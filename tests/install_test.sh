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
# shellcheck disable=SC2329
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
# shellcheck disable=SC2329
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
      timeZone: "Etc/UTC",
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
    printf 'FAIL: Gemini API mode does not enable private credential handoff\n' >&2
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
  if grep -q 'secretmanager.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Vertex-only mode unexpectedly enables Secret Manager\n' >&2
    failures=$((failures + 1))
  fi
  if ! grep -q 'aiplatform.googleapis.com' <<<"${services}"; then
    printf 'FAIL: Vertex-only mode does not enable Vertex AI\n' >&2
    failures=$((failures + 1))
  fi

  if grep -q -- '--arg geminiApiKey' "${PROJECT_ROOT}/scripts/install.sh"; then
    printf 'FAIL: Gemini API key is still serialized into clasp arguments\n' >&2
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

test_resume_runtime_overrides() {
  local actual

  write_test_state "gemini_api_with_vertex_fallback"
  GDUC_GEMINI_MODEL="gemini-2.5-flash-lite"
  GDUC_VERTEX_AI_LOCATION="europe-west1"
  apply_resume_overrides
  unset GDUC_GEMINI_MODEL GDUC_VERTEX_AI_LOCATION

  actual="$(state_get '.geminiModel')"
  assert_equal "gemini-2.5-flash-lite" "${actual}" \
    "override the pending Gemini model on resume"
  actual="$(state_get '.vertexAiLocation')"
  assert_equal "europe-west1" "${actual}" \
    "override the pending Vertex location on resume"
}

# Invoked indirectly by the rejected-credential cleanup test.
# shellcheck disable=SC2329
record_removed_secret() {
  printf '%s\n' "$1" >"${TEST_STATE_DIR}/removed-secret"
}

test_exit_zero_gemini_error_cleanup() {
  local actual

  (
    remove_gemini_transfer_secret() {
      record_removed_secret "$1"
    }
    discard_rejected_gemini_credential_if_needed \
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
# shellcheck disable=SC2329
describe_unowned_secret() {
  printf '%s\n' "unrelated_owner"
}

# Invoked indirectly by the secret-collision test helper.
# shellcheck disable=SC2329
describe_owned_secret() {
  printf '%s\n' "gduc_installer"
}

# Invoked indirectly through the assertion helpers.
# shellcheck disable=SC2329
validate_secret_collision() {
  local describe_function="$1"

  (
    gcloud() {
      "${describe_function}"
    }
    ensure_gemini_transfer_secret \
      "test-project-123" \
      "drive-utilities-cataloger-test-script-id"
  ) >/dev/null 2>&1
}

test_secret_resource_ownership() {
  local actual

  write_test_state "gemini_api"
  state_set "scriptId" "test-script-id"
  actual="$(gemini_transfer_secret_id)"
  assert_equal \
    "drive-utilities-cataloger-test-script-id" \
    "${actual}" \
    "namespace the transfer secret with the Apps Script ID"

  assert_failure "reject an existing unowned transfer secret" \
    validate_secret_collision describe_unowned_secret
  assert_success "reuse an installer-owned transfer secret" \
    validate_secret_collision describe_owned_secret
}

test_drive_id_extraction
test_input_validation
test_version_parsing
test_noninteractive_optional_input
test_custom_state_directory_safety
test_runtime_service_selection
test_secret_input_assignment
test_resume_runtime_overrides
test_exit_zero_gemini_error_cleanup
test_secret_resource_ownership

if ! bash "${PROJECT_ROOT}/scripts/install.sh" --help >/dev/null; then
  printf 'FAIL: installer help is unavailable\n' >&2
  failures=$((failures + 1))
fi

if ! make -C "${PROJECT_ROOT}" --no-print-directory |
  grep -q "install-resume"; then
  printf 'FAIL: default make target does not print installer help\n' >&2
  failures=$((failures + 1))
fi

if [[ "${failures}" -ne 0 ]]; then
  printf '%s installer test(s) failed.\n' "${failures}" >&2
  exit 1
fi

printf 'Installer helper tests passed.\n'
exit 0
