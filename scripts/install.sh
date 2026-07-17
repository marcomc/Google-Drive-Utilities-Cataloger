#!/usr/bin/env bash

set +x
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

# shellcheck source=scripts/lib/install-common.sh
source "${SCRIPT_DIR}/lib/install-common.sh"

INSTALLER_VERSION=1
DEFAULT_STATE_DIR="${PROJECT_ROOT}/.installer"
STATE_DIR="${GDUC_STATE_DIR:-${DEFAULT_STATE_DIR}}"
STATE_FILE="${STATE_DIR}/state.json"
AUTH_DIR="${STATE_DIR}/clasp-auth"
MANAGEMENT_AUTH_DIR="${STATE_DIR}/clasp-management-auth"
STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
INSTALL_LOCK_DIR="${STATE_DIR}/installer.lock"
CUSTOM_STATE_DIR_REQUESTED=0
if [[ -n "${GDUC_STATE_DIR:-}" ]]; then
  CUSTOM_STATE_DIR_REQUESTED=1
fi
INSTALL_DOC="docs/INSTALLATION.md"
CLASP_VERSION="3.3.0"
CLASP=(npx --yes "@google/clasp@${CLASP_VERSION}")
TEMP_PATHS=()
INSTALL_LOCK_HELD=0

MODE="install"
DEBUG=0
NO_OPEN=0
NON_INTERACTIVE=0
CONFIRM_RESULT=0
PREDICATE_STATUS=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  COLOR_BLUE=$'\033[34m'
  COLOR_CYAN=$'\033[36m'
  COLOR_GREEN=$'\033[32m'
  COLOR_RED=$'\033[31m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_BOLD=$'\033[1m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_BLUE=""
  COLOR_CYAN=""
  COLOR_GREEN=""
  COLOR_RED=""
  COLOR_YELLOW=""
  COLOR_BOLD=""
  COLOR_RESET=""
fi

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  local temp_path

  for temp_path in "${TEMP_PATHS[@]:-}"; do
    if [[ -n "${temp_path}" && -e "${temp_path}" ]]; then
      rm -rf "${temp_path}"
    fi
  done
  release_installer_lock
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [option]

Install Google Drive Utilities Cataloger using a resumable CLI-first workflow.

Options:
  --check             Check local tools and authentication without provisioning.
  --resume            Continue after the documented Google browser steps.
  --debug             Show additional non-secret diagnostic information.
  --no-open           Do not open browser handoff URLs automatically.
  --non-interactive   Read required values from GDUC_* environment variables.
  --reset             Remove local installer state and mapping; keep Google resources.
  -h, --help          Show this help.

Make targets:
  make install
  make install-resume
  make install-check
  make install-debug
EOF
}

info() {
  printf '%sℹ%s %s\n' "${COLOR_BLUE}" "${COLOR_RESET}" "$*"
}

success() {
  printf '%s✓%s %s\n' "${COLOR_GREEN}" "${COLOR_RESET}" "$*"
}

warning() {
  printf '%s!%s %s\n' "${COLOR_YELLOW}" "${COLOR_RESET}" "$*" >&2
}

error() {
  printf '%s✗%s %s\n' "${COLOR_RED}" "${COLOR_RESET}" "$*" >&2
}

debug() {
  if [[ "${DEBUG}" -eq 1 ]]; then
    printf '%sdebug:%s %s\n' "${COLOR_CYAN}" "${COLOR_RESET}" "$*" >&2
  fi
}

die() {
  error "$1"
  if [[ $# -gt 1 ]]; then
    printf '  Read: %s\n' "$2" >&2
  fi
  exit 1
}

print_heading() {
  printf '\n%s%s%s\n' "${COLOR_BOLD}" "$1" "${COLOR_RESET}"
}

directory_is_empty() {
  local directory="$1"
  local entry

  for entry in \
    "${directory}"/* \
    "${directory}"/.[!.]* \
    "${directory}"/..?*; do
    if [[ -e "${entry}" || -L "${entry}" ]]; then
      return 1
    fi
  done
  return 0
}

directory_contains_only_installer_state() {
  local directory="$1"
  local entry

  for entry in \
    "${directory}"/* \
    "${directory}"/.[!.]* \
    "${directory}"/..?*; do
    if [[ ! -e "${entry}" && ! -L "${entry}" ]]; then
      continue
    fi
    case "${entry##*/}" in
      .gduc-installer-state | state.json)
        if [[ -L "${entry}" || ! -f "${entry}" ]]; then
          return 1
        fi
        ;;
      clasp-auth | clasp-management-auth | installer.lock)
        if [[ -L "${entry}" || ! -d "${entry}" ]]; then
          return 1
        fi
        ;;
      *)
        return 1
        ;;
    esac
  done
  return 0
}

canonicalize_state_target() {
  local requested="${1%/}"
  local parent
  local target_name
  local canonical_parent

  if [[ -z "${requested}" || "${requested}" == "/" ]]; then
    return 1
  fi
  parent="${requested%/*}"
  target_name="${requested##*/}"
  if [[ "${target_name}" == "." || "${target_name}" == ".." ]]; then
    return 1
  fi
  if [[ -z "${parent}" ]]; then
    parent="/"
  fi
  if [[ ! -d "${parent}" ]]; then
    return 1
  fi
  canonical_parent="$(cd -P "${parent}" 2>/dev/null && pwd -P)" ||
    return 1
  printf '%s/%s\n' "${canonical_parent%/}" "${target_name}"
}

validate_state_directory_setting() {
  local requested_state_dir="${STATE_DIR%/}"
  local canonical_state_dir
  local canonical_status
  local marker_value

  if [[ "${requested_state_dir}" != /* ]]; then
    die "GDUC_STATE_DIR must be an absolute path." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi
  if [[ -L "${requested_state_dir}" ]]; then
    die "Installer state must not be a symbolic link." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi
  set +e
  canonical_state_dir="$(canonicalize_state_target "${requested_state_dir}")"
  canonical_status=$?
  set -e
  if [[ "${canonical_status}" -ne 0 ]]; then
    die "The installer state parent directory must already exist." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi
  STATE_DIR="${canonical_state_dir}"
  STATE_FILE="${STATE_DIR}/state.json"
  AUTH_DIR="${STATE_DIR}/clasp-auth"
  MANAGEMENT_AUTH_DIR="${STATE_DIR}/clasp-management-auth"
  STATE_MARKER="${STATE_DIR}/.gduc-installer-state"
  INSTALL_LOCK_DIR="${STATE_DIR}/installer.lock"

  if [[ "${CUSTOM_STATE_DIR_REQUESTED}" -eq 1 ]]; then
    case "${STATE_DIR}/" in
      "${PROJECT_ROOT}/"*)
        die "GDUC_STATE_DIR must resolve outside the repository checkout." \
          "${INSTALL_DOC}#environment-variable-reference"
        ;;
      *)
        ;;
    esac
  fi
  if [[ -L "${STATE_DIR}" ]]; then
    die "Installer state must not be a symbolic link." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi
  if [[ -e "${STATE_DIR}" && ! -d "${STATE_DIR}" ]]; then
    die "Installer state must identify a directory." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi
  if [[ ! -d "${STATE_DIR}" ]]; then
    return 0
  fi
  if [[ -f "${STATE_MARKER}" ]]; then
    marker_value="$(<"${STATE_MARKER}")"
    if [[ "${marker_value}" != "google-drive-utilities-cataloger" ]]; then
      die "Installer state has an unrecognized ownership marker." \
        "${INSTALL_DOC}#environment-variable-reference"
    fi
  else
    evaluate_predicate directory_is_empty "${STATE_DIR}"
    if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
      if [[ "${CUSTOM_STATE_DIR_REQUESTED}" -eq 1 ]]; then
        die "GDUC_STATE_DIR must be empty or already installer-owned." \
          "${INSTALL_DOC}#environment-variable-reference"
      fi
      die "The default installer state is not installer-owned." \
        "${INSTALL_DOC}#resetting-private-installer-state"
    fi
  fi

  evaluate_predicate directory_contains_only_installer_state "${STATE_DIR}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    if [[ "${CUSTOM_STATE_DIR_REQUESTED}" -eq 1 ]]; then
      die "GDUC_STATE_DIR contains unrecognized files." \
        "${INSTALL_DOC}#environment-variable-reference"
    fi
    die "The default installer state contains unrecognized files." \
      "${INSTALL_DOC}#resetting-private-installer-state"
  fi
}

ensure_state_directory() {
  mkdir -p "${STATE_DIR}"
  chmod 700 "${STATE_DIR}"
  if [[ ! -f "${STATE_MARKER}" ]]; then
    printf '%s\n' "google-drive-utilities-cataloger" >"${STATE_MARKER}"
    chmod 600 "${STATE_MARKER}"
  fi
  [[ ! -f "${STATE_FILE}" ]] || chmod 600 "${STATE_FILE}"
  [[ ! -d "${AUTH_DIR}" ]] || chmod 700 "${AUTH_DIR}"
  [[ ! -f "${AUTH_DIR}/.clasprc.json" ]] ||
    chmod 600 "${AUTH_DIR}/.clasprc.json"
  [[ ! -d "${MANAGEMENT_AUTH_DIR}" ]] ||
    chmod 700 "${MANAGEMENT_AUTH_DIR}"
  [[ ! -f "${MANAGEMENT_AUTH_DIR}/.clasprc.json" ]] ||
    chmod 600 "${MANAGEMENT_AUTH_DIR}/.clasprc.json"
}

acquire_installer_lock() {
  local lock_pid=""
  local wait_attempt

  ensure_state_directory
  if ! mkdir "${INSTALL_LOCK_DIR}" 2>/dev/null; then
    wait_attempt=0
    while [[ ! -f "${INSTALL_LOCK_DIR}/pid" &&
      "${wait_attempt}" -lt 5 ]]; do
      sleep 1
      wait_attempt=$((wait_attempt + 1))
    done
    if [[ -f "${INSTALL_LOCK_DIR}/pid" ]]; then
      lock_pid="$(<"${INSTALL_LOCK_DIR}/pid")"
    fi
    if [[ ! "${lock_pid}" =~ ^[0-9]+$ ]] ||
      ! kill -0 "${lock_pid}" 2>/dev/null; then
      warning "Removing a stale installer lock."
      rm -rf "${INSTALL_LOCK_DIR}"
      mkdir "${INSTALL_LOCK_DIR}"
    else
      die "Another installer process is already using this state directory." \
        "${INSTALL_DOC}#resetting-private-installer-state"
    fi
  fi
  INSTALL_LOCK_HELD=1
  chmod 700 "${INSTALL_LOCK_DIR}"
  printf '%s\n' "$$" >"${INSTALL_LOCK_DIR}/pid"
  chmod 600 "${INSTALL_LOCK_DIR}/pid"
}

release_installer_lock() {
  if [[ "${INSTALL_LOCK_HELD:-0}" -eq 1 ]]; then
    if [[ -f "${INSTALL_LOCK_DIR}/pid" ]] &&
      [[ "$(<"${INSTALL_LOCK_DIR}/pid")" == "$$" ]]; then
      rm -rf "${INSTALL_LOCK_DIR}"
    else
      warning "Installer lock ownership changed; leaving it untouched."
    fi
    INSTALL_LOCK_HELD=0
  fi
}

evaluate_predicate() {
  set +e
  "$@"
  PREDICATE_STATUS=$?
  set -e
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)
        MODE="check"
        ;;
      --resume)
        MODE="resume"
        ;;
      --debug)
        DEBUG=1
        ;;
      --no-open)
        NO_OPEN=1
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        ;;
      --reset)
        MODE="reset"
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

require_repository_root() {
  if [[ ! -f "${PROJECT_ROOT}/appsscript.json" ||
    ! -f "${PROJECT_ROOT}/config.example.json" ]]; then
    die "Run the installer from a complete repository clone." \
      "${INSTALL_DOC}#quick-start"
  fi
}

check_local_tools() {
  local missing=()
  local command_name
  local node_major
  local node_version

  print_heading "Local prerequisites"
  for command_name in \
    awk \
    bash \
    cat \
    chmod \
    cp \
    date \
    dirname \
    gcloud \
    git \
    jq \
    make \
    mkdir \
    mktemp \
    mv \
    node \
    npx \
    rm \
    rmdir \
    sed \
    sleep \
    tr \
    uname \
    wc; do
    if command -v "${command_name}" >/dev/null 2>&1; then
      success "${command_name}"
    else
      missing+=("${command_name}")
      error "Missing ${command_name}"
    fi
  done

  if command -v node >/dev/null 2>&1; then
    node_version="$(node --version)"
    node_major="$(major_version "${node_version}")"
    if [[ -z "${node_major}" || "${node_major}" -lt 20 ]]; then
      missing+=("Node.js 20+")
      error "Node.js 20 or newer is required; found ${node_version}."
    else
      success "Node.js ${node_version}"
    fi
  fi

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf '\nMissing: %s\n' "${missing[*]}" >&2
    die "Install the missing local prerequisites before continuing." \
      "${INSTALL_DOC}#local-tools"
  fi

  if "${CLASP[@]}" --version >/dev/null 2>&1; then
    success "clasp ${CLASP_VERSION} available through npx"
  else
    die "npx could not load clasp ${CLASP_VERSION}." \
      "${INSTALL_DOC}#clasp"
  fi
}

active_gcloud_account() {
  gcloud auth list \
    --filter='status:ACTIVE' \
    --format='value(account)' \
    --limit=1 2>/dev/null
}

authorized_clasp_account() {
  local auth_dir="$1"
  local clasp_output

  if ! clasp_output="$("${CLASP[@]}" -A "${auth_dir}" --json \
    show-authorized-user 2>/dev/null)"; then
    return 1
  fi
  printf '%s' "${clasp_output}" |
    jq -r 'select(.loggedIn == true) | .email // empty'
}

verify_clasp_owner_account() {
  local auth_dir="$1"
  local clasp_account
  local clasp_status
  local cloud_account

  set +e
  clasp_account="$(authorized_clasp_account "${auth_dir}")"
  clasp_status=$?
  set -e
  if [[ "${clasp_status}" -ne 0 ]]; then
    die "Could not verify the clasp account." "${INSTALL_DOC}#clasp"
  fi
  if [[ -z "${clasp_account}" ]]; then
    die "clasp did not report an authorized Google account." \
      "${INSTALL_DOC}#clasp"
  fi

  cloud_account="$(active_gcloud_account)"
  if [[ "${clasp_account}" == "${cloud_account}" ]]; then
    success "clasp and gcloud use the same owner account"
    return 0
  fi

  die "clasp uses ${clasp_account}, but gcloud uses ${cloud_account}." \
    "${INSTALL_DOC}#google-cloud-cli"
}

check_google_cli_access() {
  local account
  local billing_accounts

  print_heading "Google CLI access"
  account="$(active_gcloud_account)"
  if [[ -z "${account}" ]]; then
    die "gcloud has no active user account. Run: gcloud auth login" \
      "${INSTALL_DOC}#google-cloud-cli"
  fi
  success "gcloud account: ${account}"

  if ! gcloud projects list --limit=1 >/dev/null 2>&1; then
    die "The active gcloud account cannot list Cloud projects." \
      "${INSTALL_DOC}#google-cloud-cli"
  fi
  success "Cloud project access"

  if ! billing_accounts="$(gcloud billing accounts list \
    --filter='open=true' --format='value(name)' 2>/dev/null)"; then
    die "The active account cannot inspect Cloud billing accounts." \
      "${INSTALL_DOC}#cloud-billing"
  fi
  if [[ -z "${billing_accounts}" ]]; then
    die "No open Cloud billing account is available." \
      "${INSTALL_DOC}#cloud-billing"
  fi
  success "Open Cloud billing account available"
}

run_preflight() {
  require_repository_root
  check_local_tools
  check_google_cli_access
  success "Preflight complete."
}

prompt_value() {
  local result_variable="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local supplied_value="${4:-}"
  local entered_value

  if [[ -n "${supplied_value}" ]]; then
    printf -v "${result_variable}" '%s' "${supplied_value}"
    return 0
  fi
  if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
    if [[ -n "${default_value}" ]]; then
      printf -v "${result_variable}" '%s' "${default_value}"
      return 0
    fi
    die "Non-interactive installation is missing ${result_variable}." \
      "${INSTALL_DOC}#environment-variable-reference"
  fi

  if [[ -n "${default_value}" ]]; then
    read -r -p "${prompt_text} [${default_value}]: " entered_value
    entered_value="${entered_value:-${default_value}}"
  else
    read -r -p "${prompt_text}: " entered_value
  fi
  printf -v "${result_variable}" '%s' "${entered_value}"
}

prompt_optional_value() {
  local result_variable="$1"
  local prompt_text="$2"
  local supplied_value="${3:-}"
  local entered_value=""

  if [[ -n "${supplied_value}" ]]; then
    printf -v "${result_variable}" '%s' "${supplied_value}"
    return 0
  fi
  if [[ "${NON_INTERACTIVE}" -eq 0 ]]; then
    read -r -p "${prompt_text}: " entered_value
  fi
  printf -v "${result_variable}" '%s' "${entered_value}"
}

confirm() {
  local prompt_text="$1"
  local default_answer="${2:-yes}"
  local answer

  if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
    if [[ "${default_answer}" == "yes" ]]; then
      CONFIRM_RESULT=1
    else
      CONFIRM_RESULT=0
    fi
    return 0
  fi

  if [[ "${default_answer}" == "yes" ]]; then
    read -r -p "${prompt_text} [Y/n]: " answer
    answer="${answer:-yes}"
  else
    read -r -p "${prompt_text} [y/N]: " answer
    answer="${answer:-no}"
  fi
  case "${answer}" in
    1 | true | TRUE | yes | YES | y | Y | on | ON)
      CONFIRM_RESULT=1
      ;;
    *)
      CONFIRM_RESULT=0
      ;;
  esac
  return 0
}

default_project_id() {
  local suffix

  suffix="$(date '+%y%m%d')-$((RANDOM % 9000 + 1000))"
  printf 'drive-utilities-%s\n' "${suffix}"
}

select_billing_account() {
  local project_id="${1:-}"
  local requested="${GDUC_BILLING_ACCOUNT_ID:-}"
  local default_id=""
  local account_id
  local current_billing_account=""
  local display_name
  local first_id=""
  local line
  local billing_output

  if [[ -n "${requested}" ]]; then
    printf '%s\n' "${requested#billingAccounts/}"
    return 0
  fi

  if [[ -n "${project_id}" ]]; then
    current_billing_account="$(gcloud billing projects describe "${project_id}" \
      --format='value(billingAccountName)' 2>/dev/null || true)"
    current_billing_account="${current_billing_account#billingAccounts/}"
  fi

  print_heading "Available billing accounts" >&2
  billing_output="$(gcloud billing accounts list \
    --filter='open=true' \
    --format='value(name,displayName)')"
  while IFS= read -r line; do
    account_id="${line%%$'\t'*}"
    display_name="${line#*$'\t'}"
    account_id="${account_id#billingAccounts/}"
    if [[ -z "${first_id}" ]]; then
      first_id="${account_id}"
    fi
    if [[ -n "${current_billing_account}" &&
      "${account_id}" == "${current_billing_account}" ]]; then
      default_id="${account_id}"
    fi
    printf '  %-22s %s\n' "${account_id}" "${display_name}" >&2
  done <<<"${billing_output}"
  default_id="${default_id:-${first_id}}"

  prompt_value account_id \
    "Billing account ID" \
    "${default_id}" \
    ""
  printf '%s\n' "${account_id#billingAccounts/}"
}

select_gemini_mode() {
  local selected="${GDUC_GEMINI_MODE:-}"

  if [[ -n "${selected}" ]]; then
    evaluate_predicate is_valid_gemini_mode "${selected}"
    if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
      die "Unsupported GDUC_GEMINI_MODE: ${selected}" \
        "${INSTALL_DOC}#gemini-runtime"
    fi
    printf '%s\n' "${selected}"
    return 0
  fi

  if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
    printf '%s\n' "gemini_api"
    return 0
  fi

  print_heading "Gemini runtime" >&2
  printf '  1. Gemini Developer API (API key from Google AI Studio)\n' >&2
  printf '  2. Vertex AI (Cloud billing)\n' >&2
  printf '  3. Gemini Developer API with one-hour Vertex fallback\n' >&2
  read -r -p "Select runtime [1]: " selected
  case "${selected:-1}" in
    1)
      printf '%s\n' "gemini_api"
      ;;
    2)
      printf '%s\n' "vertex_ai"
      ;;
    3)
      printf '%s\n' "gemini_api_with_vertex_fallback"
      ;;
    *)
      die "Gemini runtime selection must be 1, 2, or 3." \
        "${INSTALL_DOC}#gemini-runtime"
      ;;
  esac
}

write_initial_state() {
  local settings_json="$1"
  local gemini_metadata
  local gemini_mode
  local gemini_backend
  local gemini_api_key_required
  local gemini_vertex_required
  local gemini_auto_vertex_fallback
  local temp_file

  gemini_mode="$(jq -r '.geminiMode // empty' <<<"${settings_json}")"
  gemini_metadata="$(gemini_mode_metadata "${gemini_mode}")"
  IFS=$'\t' read -r \
    gemini_backend \
    gemini_api_key_required \
    gemini_vertex_required \
    gemini_auto_vertex_fallback <<<"${gemini_metadata}"

  ensure_state_directory
  temp_file="$(mktemp "${STATE_FILE}.tmp.XXXXXX")"
  TEMP_PATHS+=("${temp_file}")
  jq \
    --argjson installerVersion "${INSTALLER_VERSION}" \
    --arg phase "collected" \
    --arg geminiBackend "${gemini_backend}" \
    --argjson geminiApiKeyRequired "${gemini_api_key_required}" \
    --argjson geminiVertexRequired "${gemini_vertex_required}" \
    --argjson geminiAutoVertexFallback "${gemini_auto_vertex_fallback}" \
    '. + {
      installerVersion: $installerVersion,
      phase: $phase,
      geminiBackend: $geminiBackend,
      geminiApiKeyRequired: $geminiApiKeyRequired,
      geminiVertexRequired: $geminiVertexRequired,
      geminiAutoVertexFallback: $geminiAutoVertexFallback
    }' <<<"${settings_json}" >"${temp_file}"
  chmod 600 "${temp_file}"
  mv "${temp_file}" "${STATE_FILE}"
}

state_get() {
  local expression="$1"

  jq -r \
    "(${expression}) as \$value |
      if \$value == null then empty else \$value end" \
    "${STATE_FILE}"
}

state_set() {
  local key="$1"
  local value="$2"
  local temp_file

  temp_file="$(mktemp "${STATE_FILE}.tmp.XXXXXX")"
  TEMP_PATHS+=("${temp_file}")

  jq --arg value "${value}" ".${key} = \$value" \
    "${STATE_FILE}" >"${temp_file}"
  chmod 600 "${temp_file}"
  mv "${temp_file}" "${STATE_FILE}"
}

validate_installer_state() {
  if ! jq -e --argjson installerVersion "${INSTALLER_VERSION}" '
    type == "object" and
    .installerVersion == $installerVersion and
    (.phase | type == "string" and length > 0) and
    (.projectId | type == "string" and length > 0)
  ' "${STATE_FILE}" >/dev/null 2>&1; then
    die "Installer state is invalid or belongs to an unsupported version." \
      "${INSTALL_DOC}#resetting-private-installer-state"
  fi
}

collect_installation_inputs() {
  local account
  local project_name
  local project_id
  local suggested_project_id
  local billing_account_id
  local billing_account_open
  local locale
  local time_zone
  local notification_recipient
  local root_folder_input
  local root_folder_id
  local spreadsheet_input
  local spreadsheet_id=""
  local spreadsheet_title
  local gemini_mode
  local gemini_model
  local vertex_ai_location
  local initial_settings
  local reuse_project_value
  local extraction_status
  local supported_locales

  print_heading "Installation settings"
  account="$(active_gcloud_account)"
  prompt_value project_name \
    "Cloud and Apps Script project name" \
    "Drive Utilities Cataloger" \
    "${GDUC_PROJECT_NAME:-}"
  suggested_project_id="$(default_project_id)"
  prompt_value project_id \
    "Globally unique Google Cloud project ID" \
    "${suggested_project_id}" \
    "${GDUC_PROJECT_ID:-}"
  evaluate_predicate is_valid_project_id "${project_id}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Invalid Google Cloud project ID: ${project_id}" \
      "${INSTALL_DOC}#project-settings"
  fi

  if gcloud projects describe "${project_id}" >/dev/null 2>&1; then
    reuse_project_value="$(printf '%s' "${GDUC_REUSE_PROJECT:-false}" |
      tr '[:upper:]' '[:lower:]')"
    if [[ "${reuse_project_value}" != "1" &&
      "${reuse_project_value}" != "true" &&
      "${reuse_project_value}" != "yes" &&
      "${reuse_project_value}" != "y" &&
      "${reuse_project_value}" != "on" ]]; then
      confirm "Cloud project ${project_id} already exists. Reuse it?" "no"
    else
      CONFIRM_RESULT=1
    fi
    if [[ "${CONFIRM_RESULT}" -ne 1 ]]; then
      die "Choose a new project ID or set GDUC_REUSE_PROJECT=true." \
        "${INSTALL_DOC}#project-settings"
    fi
  fi

  billing_account_id="$(select_billing_account "${project_id}")"
  if ! billing_account_open="$(gcloud billing accounts describe \
    "${billing_account_id}" --format='value(open)' 2>/dev/null)"; then
    die "Billing account ${billing_account_id} is unavailable or closed." \
      "${INSTALL_DOC}#cloud-billing"
  fi
  billing_account_open="$(printf '%s' "${billing_account_open}" |
    tr '[:upper:]' '[:lower:]')"
  if [[ "${billing_account_open}" != "true" ]]; then
    die "Billing account ${billing_account_id} is unavailable or closed." \
      "${INSTALL_DOC}#cloud-billing"
  fi
  success "Billing account is open and accessible"
  supported_locales="$(node "${PROJECT_ROOT}/scripts/list-locales.js")"
  prompt_value locale \
    "Output locale (${supported_locales})" \
    "en" \
    "${GDUC_LOCALE:-}"
  evaluate_predicate is_supported_locale "${locale}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Locale must be one of: ${supported_locales}." \
      "${INSTALL_DOC}#project-settings"
  fi
  prompt_value time_zone \
    "Apps Script IANA time zone" \
    "Etc/UTC" \
    "${GDUC_TIME_ZONE:-}"
  evaluate_predicate is_valid_time_zone "${time_zone}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Invalid IANA time zone: ${time_zone}" \
      "${INSTALL_DOC}#project-settings"
  fi
  prompt_value notification_recipient \
    "Email recipient for automation reports" \
    "${account}" \
    "${GDUC_NOTIFICATION_RECIPIENT:-}"
  evaluate_predicate is_valid_email "${notification_recipient}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Invalid report email address: ${notification_recipient}" \
      "${INSTALL_DOC}#project-settings"
  fi

  prompt_value root_folder_input \
    "Google Drive intake-folder URL or ID" \
    "" \
    "${GDUC_ROOT_FOLDER:-}"
  set +e
  root_folder_id="$(extract_google_resource_id "${root_folder_input}")"
  extraction_status=$?
  set -e
  if [[ "${extraction_status}" -ne 0 || -z "${root_folder_id}" ]]; then
    die "Could not extract a Google Drive folder ID." \
      "${INSTALL_DOC}#drive-and-spreadsheet"
  fi

  prompt_optional_value spreadsheet_input \
    "Existing Google Spreadsheet URL or ID; leave empty to create one" \
    "${GDUC_SPREADSHEET:-}"
  if [[ -n "${spreadsheet_input}" ]]; then
    set +e
    spreadsheet_id="$(extract_google_resource_id "${spreadsheet_input}")"
    extraction_status=$?
    set -e
    if [[ "${extraction_status}" -ne 0 || -z "${spreadsheet_id}" ]]; then
      die "Could not extract the Google Spreadsheet ID." \
        "${INSTALL_DOC}#drive-and-spreadsheet"
    fi
  fi
  prompt_value spreadsheet_title \
    "Spreadsheet title" \
    "${project_name} - Utilities" \
    "${GDUC_SPREADSHEET_TITLE:-}"
  gemini_mode="$(select_gemini_mode)"
  gemini_model="${GDUC_GEMINI_MODEL:-gemini-2.5-flash}"
  vertex_ai_location="${GDUC_VERTEX_AI_LOCATION:-global}"
  evaluate_predicate is_valid_gemini_model "${gemini_model}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Invalid Gemini model identifier: ${gemini_model}" \
      "${INSTALL_DOC}#gemini-runtime"
  fi
  evaluate_predicate is_valid_vertex_location "${vertex_ai_location}"
  if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
    die "Invalid Vertex AI location: ${vertex_ai_location}" \
      "${INSTALL_DOC}#gemini-runtime"
  fi

  initial_settings="$(jq -n \
    --arg projectName "${project_name}" \
    --arg projectId "${project_id}" \
    --arg billingAccountId "${billing_account_id}" \
    --arg locale "${locale}" \
    --arg timeZone "${time_zone}" \
    --arg notificationRecipient "${notification_recipient}" \
    --arg rootFolderId "${root_folder_id}" \
    --arg spreadsheetId "${spreadsheet_id}" \
    --arg spreadsheetTitle "${spreadsheet_title}" \
    --arg geminiMode "${gemini_mode}" \
    --arg geminiModel "${gemini_model}" \
    --arg vertexAiLocation "${vertex_ai_location}" \
    '{
      projectName: $projectName,
      projectId: $projectId,
      billingAccountId: $billingAccountId,
      locale: $locale,
      timeZone: $timeZone,
      notificationRecipient: $notificationRecipient,
      rootFolderId: $rootFolderId,
      spreadsheetId: $spreadsheetId,
      spreadsheetTitle: $spreadsheetTitle,
      geminiMode: $geminiMode,
      geminiModel: $geminiModel,
      vertexAiLocation: $vertexAiLocation
    }')"
  write_initial_state "${initial_settings}"
  success "Private installer state saved to ${STATE_FILE}"
}

prepare_local_config() {
  local locale
  local temp_file

  locale="$(state_get '.locale')"
  if [[ -f "${PROJECT_ROOT}/config.local.json" ]]; then
    if ! jq empty "${PROJECT_ROOT}/config.local.json"; then
      die "config.local.json is not valid JSON." \
        "docs/CONFIGURATION.md#local-configuration-file"
    fi
    chmod 600 "${PROJECT_ROOT}/config.local.json"
    success "Using existing config.local.json"
    return 0
  fi

  temp_file="$(mktemp "${PROJECT_ROOT}/config.local.json.tmp.XXXXXX")"
  TEMP_PATHS+=("${temp_file}")
  jq --arg locale "${locale}" '.locale = $locale' \
    "${PROJECT_ROOT}/config.example.json" >"${temp_file}"
  chmod 600 "${temp_file}"
  mv "${temp_file}" "${PROJECT_ROOT}/config.local.json"
  success "Created private config.local.json with locale ${locale}"
  info "Customize it before make install-resume; example values are rejected."
}

validate_local_config_for_installation() {
  local configured_locale
  local locale

  if [[ ! -f "${PROJECT_ROOT}/config.local.json" ]]; then
    die "config.local.json is missing." \
      "docs/CONFIGURATION.md#local-configuration-file"
  fi
  if ! jq -e '
    (.locale | type == "string" and length > 0) and
    (.canonical_supplies | type == "array" and length > 0) and
    (.canonical_suppliers | type == "array" and length > 0) and
    (.supply_aliases | type == "object") and
    (.supplier_aliases | type == "object") and
    (.address_rules | type == "array") and
    (.archive_only_folder_path | type == "string" and length > 0) and
    (.destination_templates | type == "object") and
    (.sheet_by_supply | type == "object")
  ' "${PROJECT_ROOT}/config.local.json" >/dev/null; then
    die "config.local.json does not satisfy the required schema." \
      "docs/CONFIGURATION.md#local-configuration-file"
  fi
  if ! node "${PROJECT_ROOT}/scripts/validate-config.js" \
    "${PROJECT_ROOT}/config.local.json" >/dev/null; then
    die "config.local.json failed nested schema validation." \
      "docs/CONFIGURATION.md#local-configuration-file"
  fi

  locale="$(state_get '.locale')"
  configured_locale="$(jq -r '.locale' "${PROJECT_ROOT}/config.local.json")"
  if [[ "${configured_locale}" != "${locale}" ]]; then
    die "config.local.json locale does not match the installer locale ${locale}." \
      "docs/CONFIGURATION.md#local-configuration-file"
  fi
  if jq -e '
    [.. | strings] |
    any(.[];
      . == "WATER PROVIDER" or
      . == "WATER PROVIDER LTD" or
      . == "ENERGY PROVIDER" or
      . == "ENERGY PROVIDER LTD" or
      . == "INTERNET PROVIDER" or
      . == "ADDRESS FOR IMPORT" or
      . == "ADDRESS FOR ARCHIVE ONLY"
    )
  ' "${PROJECT_ROOT}/config.local.json" >/dev/null; then
    die "Replace every example supplier and address in config.local.json." \
      "docs/CONFIGURATION.md#local-configuration-file"
  fi
  success "Private automation configuration validated"
}

required_cloud_services() {
  local gemini_vertex_required

  gemini_vertex_required="$(state_get '.geminiVertexRequired')"
  printf '%s\n' \
    drive.googleapis.com \
    logging.googleapis.com \
    pubsub.googleapis.com \
    script.googleapis.com \
    secretmanager.googleapis.com \
    sheets.googleapis.com \
    workspaceevents.googleapis.com
  if [[ "${gemini_vertex_required}" == "true" ]]; then
    printf '%s\n' aiplatform.googleapis.com
  fi
}

provision_cloud_project() {
  local project_id
  local project_name
  local billing_account_id
  local billing_account_name
  local billing_enabled
  local services=()
  local service
  local services_output

  project_id="$(state_get '.projectId')"
  project_name="$(state_get '.projectName')"
  billing_account_id="$(state_get '.billingAccountId')"

  print_heading "Google Cloud project"
  if gcloud projects describe "${project_id}" >/dev/null 2>&1; then
    info "Using existing Cloud project ${project_id}"
  else
    debug "Creating Cloud project ${project_id}"
    gcloud projects create "${project_id}" \
      --name="${project_name}" \
      --quiet
    success "Created Cloud project ${project_id}"
  fi

  billing_account_name="$(gcloud billing projects describe "${project_id}" \
    --format='value(billingAccountName)' 2>/dev/null || true)"
  billing_enabled="$(gcloud billing projects describe "${project_id}" \
    --format='value(billingEnabled)' 2>/dev/null || true)"
  if [[ (
    "${billing_enabled}" != "True" &&
    "${billing_enabled}" != "true"
  ) || "${billing_account_name#billingAccounts/}" != "${billing_account_id}" ]]; then
    if [[ -n "${billing_account_name}" &&
      "${billing_account_name#billingAccounts/}" != "${billing_account_id}" &&
      "${GDUC_ALLOW_BILLING_RELINK:-false}" != "true" ]]; then
      if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
        die "Set GDUC_ALLOW_BILLING_RELINK=true to change existing project billing." \
          "${INSTALL_DOC}#environment-variable-reference"
      fi
      warning "Project billing currently uses ${billing_account_name#billingAccounts/}."
      confirm "Relink it to billing account ${billing_account_id}?" "no"
      if [[ "${CONFIRM_RESULT}" -ne 1 ]]; then
        die "Cloud billing was not changed." \
          "${INSTALL_DOC}#cloud-billing"
      fi
    fi
    debug "Linking billing account ${billing_account_id}"
    gcloud billing projects link "${project_id}" \
      --billing-account="${billing_account_id}" \
      --quiet
    success "Linked Cloud billing"
  else
    success "Cloud billing already enabled"
  fi

  services_output="$(required_cloud_services)"
  while IFS= read -r service; do
    services+=("${service}")
  done <<<"${services_output}"
  debug "Enabling ${#services[@]} required APIs"
  gcloud services enable \
    --project="${project_id}" \
    "${services[@]}"
  success "Required Google APIs enabled"
  state_set "phase" "cloud_ready"
}

ensure_clasp_management_access() {
  local auth_output

  print_heading "Apps Script CLI authorization"
  if [[ -f "${MANAGEMENT_AUTH_DIR}/.clasprc.json" ]] &&
    auth_output="$("${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" --json \
      show-authorized-user 2>/dev/null)" &&
    printf '%s' "${auth_output}" |
      jq -e '.loggedIn == true and (.email | length > 0)' >/dev/null; then
    success "Reusing isolated Apps Script management authorization"
  else
    rm -rf "${MANAGEMENT_AUTH_DIR}"
    warning "clasp is not authorized for an Apps Script account."
    confirm "Open the clasp Google login now?" "yes"
    if [[ "${CONFIRM_RESULT}" -ne 1 ]]; then
      die "Authorize clasp before continuing." "${INSTALL_DOC}#clasp"
    fi
    mkdir -p "${MANAGEMENT_AUTH_DIR}"
    chmod 700 "${MANAGEMENT_AUTH_DIR}"
    "${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" login
    chmod 600 "${MANAGEMENT_AUTH_DIR}/.clasprc.json"
  fi
  success "clasp account authorization"
  verify_clasp_owner_account "${MANAGEMENT_AUTH_DIR}"

  if ! "${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" --json list >/dev/null 2>&1; then
    warning "The account-level Google Apps Script API is not enabled."
    if [[ "${NO_OPEN}" -eq 0 ]]; then
      set +e
      open_url "https://script.google.com/home/usersettings"
      set -e
    fi
    state_set "phase" "apps_script_api_required"
    die "Enable the Google Apps Script API, then run make install-resume." \
      "${INSTALL_DOC}#apps-script-api"
  fi
  success "Account-level Apps Script API enabled"
}

check_clasp_readiness() {
  local clasp_output

  print_heading "Apps Script CLI access"
  if [[ ! -f "${MANAGEMENT_AUTH_DIR}/.clasprc.json" ]]; then
    info "Isolated clasp authorization will be created by make install."
    return 0
  fi
  if ! clasp_output="$("${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" --json \
    show-authorized-user 2>/dev/null)" ||
    ! printf '%s' "${clasp_output}" |
      jq -e '.loggedIn == true and (.email | length > 0)' >/dev/null; then
    die "The isolated clasp authorization is invalid; run make install." \
      "${INSTALL_DOC}#clasp"
  fi
  verify_clasp_owner_account "${MANAGEMENT_AUTH_DIR}"
  "${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" --json list >/dev/null 2>&1 ||
    die "Enable the account-level Google Apps Script API." \
      "${INSTALL_DOC}#apps-script-api"
  success "Isolated clasp authorization is ready"
}

create_apps_script_project() {
  local project_id
  local project_name
  local bootstrap_dir
  local mapped_project_id
  local stored_script_id
  local temp_file
  local script_id

  if [[ -f "${PROJECT_ROOT}/.clasp.json" ]]; then
    if ! jq empty "${PROJECT_ROOT}/.clasp.json" >/dev/null 2>&1; then
      die ".clasp.json is not valid JSON." \
        "${INSTALL_DOC}#apps-script-project"
    fi
    script_id="$(jq -r '.scriptId // empty' "${PROJECT_ROOT}/.clasp.json")"
    mapped_project_id="$(jq -r '.projectId // empty' \
      "${PROJECT_ROOT}/.clasp.json")"
    project_id="$(state_get '.projectId')"
    stored_script_id="$(state_get '.scriptId')"
    if [[ -z "${script_id}" ||
      ! "${script_id}" =~ ^[A-Za-z0-9_-]+$ ]]; then
      die ".clasp.json does not contain a valid scriptId." \
        "${INSTALL_DOC}#apps-script-project"
    fi
    if [[ "${mapped_project_id}" != "${project_id}" ]]; then
      die ".clasp.json targets a different Google Cloud project." \
        "${INSTALL_DOC}#apps-script-project"
    fi
    if [[ -n "${stored_script_id}" &&
      "${stored_script_id}" != "${script_id}" ]]; then
      die ".clasp.json targets a different Apps Script project than installer state." \
        "${INSTALL_DOC}#apps-script-project"
    fi
    chmod 600 "${PROJECT_ROOT}/.clasp.json"
    success "Using existing Apps Script project mapping"
    state_set "scriptId" "${script_id}"
    state_set "phase" "script_ready"
    return 0
  fi

  project_id="$(state_get '.projectId')"
  project_name="$(state_get '.projectName')"
  bootstrap_dir="$(mktemp -d)"
  TEMP_PATHS+=("${bootstrap_dir}")
  debug "Creating Apps Script project outside the source checkout"
  (
    cd "${bootstrap_dir}"
    "${CLASP[@]}" -A "${MANAGEMENT_AUTH_DIR}" create \
      --type standalone \
      --title "${project_name}"
  )
  if [[ ! -f "${bootstrap_dir}/.clasp.json" ]]; then
    die "clasp did not create .clasp.json." \
      "${INSTALL_DOC}#apps-script-project"
  fi

  temp_file="${bootstrap_dir}/.clasp.project.json"
  jq --arg projectId "${project_id}" \
    '.projectId = $projectId | .rootDir = "."' \
    "${bootstrap_dir}/.clasp.json" >"${temp_file}"
  chmod 600 "${temp_file}"
  mv "${temp_file}" "${PROJECT_ROOT}/.clasp.json"
  script_id="$(jq -r '.scriptId' "${PROJECT_ROOT}/.clasp.json")"
  state_set "scriptId" "${script_id}"
  state_set "phase" "script_ready"
  success "Created standalone Apps Script project"
}

push_apps_script_source() {
  local auth_dir="$1"
  local staging_dir
  local time_zone
  local source_file

  staging_dir="$(mktemp -d)"
  TEMP_PATHS+=("${staging_dir}")
  time_zone="$(state_get '.timeZone')"
  cp "${PROJECT_ROOT}/.clasp.json" "${staging_dir}/.clasp.json"
  jq --arg timeZone "${time_zone}" '.timeZone = $timeZone' \
    "${PROJECT_ROOT}/appsscript.json" >"${staging_dir}/appsscript.json"
  for source_file in "${PROJECT_ROOT}"/*.gs; do
    cp "${source_file}" "${staging_dir}/"
  done
  mkdir -p "${staging_dir}/locales"
  cp "${PROJECT_ROOT}"/locales/*.gs "${staging_dir}/locales/"

  debug "Uploading Apps Script source with time zone ${time_zone}"
  "${CLASP[@]}" -A "${auth_dir}" -P "${staging_dir}" push --force
  success "Apps Script source uploaded"
}

open_browser_handoff() {
  local project_id
  local project_number
  local script_id
  local urls=()
  local url
  local open_status

  project_id="$(state_get '.projectId')"
  project_number="$(gcloud projects describe "${project_id}" \
    --format='value(projectNumber)')"
  script_id="$(state_get '.scriptId')"
  state_set "projectNumber" "${project_number}"
  state_set "phase" "browser_required"

  urls=(
    "https://developers.google.com/workspace/preview"
    "https://script.google.com/home/usersettings"
    "https://console.cloud.google.com/auth/audience?project=${project_id}"
    "https://console.cloud.google.com/auth/clients?project=${project_id}"
    "https://script.google.com/home/projects/${script_id}/settings"
  )

  print_heading "One-time Google browser handoff"
  printf 'Complete these steps in order:\n\n'
  printf '  1. Join the Google Workspace Developer Preview if required.\n'
  printf '  2. Confirm the account-level Apps Script API is enabled.\n'
  printf '  3. Configure a durable OAuth audience; do not leave it in Testing.\n'
  printf '  4. Create a Desktop OAuth client and download its JSON file.\n'
  printf '  5. Link the Apps Script project to Cloud project number %s.\n\n' \
    "${project_number}"
  printf '  6. Customize config.local.json if the installer created it.\n\n'
  printf 'Then resume:\n'
  printf '  GDUC_OAUTH_CLIENT_JSON=/path/to/client.json make install-resume\n\n'
  printf 'Detailed procedure: %s#browser-handoff\n' "${INSTALL_DOC}"

  if [[ "${NO_OPEN}" -eq 0 ]]; then
    for url in "${urls[@]}"; do
      set +e
      open_url "${url}"
      open_status=$?
      set -e
      if [[ "${open_status}" -ne 0 ]]; then
        warning "Open manually: ${url}"
      fi
    done
  else
    printf '\nURLs:\n'
    for url in "${urls[@]}"; do
      printf '  %s\n' "${url}"
    done
  fi
}

continue_initial_install() {
  local phase

  phase="$(state_get '.phase')"
  if [[ "${phase}" == "collected" ]]; then
    prepare_local_config
    provision_cloud_project
    phase="cloud_ready"
  fi
  if [[ "${phase}" == "cloud_ready" ||
    "${phase}" == "apps_script_api_required" ]]; then
    ensure_clasp_management_access
    create_apps_script_project
    phase="script_ready"
  fi
  if [[ "${phase}" == "script_ready" ]]; then
    push_apps_script_source "${MANAGEMENT_AUTH_DIR}"
    open_browser_handoff
  fi
}

validate_oauth_client() {
  local client_file="$1"
  local canonical_client_dir
  local canonical_client_file
  local client_basename
  local client_id
  local project_number

  if [[ ! -f "${client_file}" ]]; then
    die "OAuth client JSON file not found: ${client_file}" \
      "${INSTALL_DOC}#desktop-oauth-client"
  fi
  if [[ -L "${client_file}" ]]; then
    die "OAuth client JSON must not be a symbolic link." \
      "${INSTALL_DOC}#desktop-oauth-client"
  fi
  chmod 600 "${client_file}" ||
    die "Could not restrict OAuth client JSON permissions." \
      "${INSTALL_DOC}#desktop-oauth-client"
  canonical_client_dir="$(
    cd -P "$(dirname "${client_file}")" 2>/dev/null &&
      pwd -P
  )" || die "Could not resolve the OAuth client path." \
    "${INSTALL_DOC}#desktop-oauth-client"
  client_basename="$(basename "${client_file}")"
  canonical_client_file="${canonical_client_dir}/${client_basename}"
  case "${canonical_client_file}" in
    "${PROJECT_ROOT}"/*)
      die "Keep the OAuth client JSON outside the repository checkout." \
        "${INSTALL_DOC}#desktop-oauth-client"
      ;;
    *)
      ;;
  esac
  if ! jq empty "${client_file}" >/dev/null 2>&1; then
    die "OAuth client file is not valid JSON." \
      "${INSTALL_DOC}#desktop-oauth-client"
  fi
  client_id="$(jq -r '.installed.client_id // empty' "${client_file}")"
  if [[ -z "${client_id}" ]]; then
    die "OAuth client JSON has no installed.client_id." \
      "${INSTALL_DOC}#desktop-oauth-client"
  fi
  project_number="$(state_get '.projectNumber')"
  if [[ "${client_id}" != "${project_number}-"* ]]; then
    die "The OAuth client belongs to a different Cloud project." \
      "${INSTALL_DOC}#desktop-oauth-client"
  fi
  success "Desktop OAuth client belongs to project ${project_number}"
}

authorize_installer_execution() {
  local client_file="$1"
  local auth_output

  if [[ -f "${AUTH_DIR}/.clasprc.json" ]]; then
    if auth_output="$("${CLASP[@]}" -A "${AUTH_DIR}" --json \
      show-authorized-user 2>/dev/null)" &&
      printf '%s' "${auth_output}" |
        jq -e '.loggedIn == true and (.email | length > 0)' >/dev/null; then
      success "Reusing owner-only installer authorization"
      verify_clasp_owner_account "${AUTH_DIR}"
      return 0
    fi
    warning "Stored installer authorization is invalid; recreating it."
    rm -rf "${AUTH_DIR}"
  fi

  mkdir -p "${AUTH_DIR}"
  chmod 700 "${AUTH_DIR}"
  print_heading "Owner-only Apps Script authorization"
  "${CLASP[@]}" -A "${AUTH_DIR}" login \
    --creds "${client_file}" \
    --use-project-scopes \
    --include-clasp-scopes
  chmod 600 "${AUTH_DIR}/.clasprc.json"
  success "Owner-only installer authorization complete"
  verify_clasp_owner_account "${AUTH_DIR}"
}

ensure_api_executable_deployment() {
  local deployment_id
  local deployment_output
  local existing_deployments

  deployment_id="$(state_get '.deploymentId')"
  if [[ -n "${deployment_id}" ]]; then
    if ! existing_deployments="$("${CLASP[@]}" -A "${AUTH_DIR}" --json \
      deployments 2>/dev/null)"; then
      die "Could not verify the stored Apps Script API deployment." \
        "${INSTALL_DOC}#api-executable"
    fi
    if printf '%s' "${existing_deployments}" |
      jq -e --arg id "${deployment_id}" \
        'any(.[]; .deploymentId == $id)' >/dev/null; then
      success "Using installer API deployment"
      return 0
    fi
    warning "The stored Apps Script deployment no longer exists; recreating it."
    state_set "deploymentId" ""
  fi

  debug "Creating owner-only Apps Script API deployment"
  deployment_output="$("${CLASP[@]}" -A "${AUTH_DIR}" --json deploy \
    --description "Owner-only installer bootstrap")"
  deployment_id="$(printf '%s' "${deployment_output}" |
    jq -r '.deploymentId // empty' 2>/dev/null || true)"
  if [[ -z "${deployment_id}" ]]; then
    printf '%s\n' "${deployment_output}" >&2
    die "Could not identify the Apps Script API deployment." \
      "${INSTALL_DOC}#api-executable"
  fi
  state_set "deploymentId" "${deployment_id}"
  success "Created owner-only Apps Script API deployment"
}

read_gemini_key() {
  local result_variable="$1"
  local gemini_api_key_required
  local entered_key="${GDUC_GEMINI_API_KEY:-}"

  unset GDUC_GEMINI_API_KEY
  gemini_api_key_required="$(state_get '.geminiApiKeyRequired')"
  if [[ "${gemini_api_key_required}" != "true" ]]; then
    printf -v "${result_variable}" '%s' ""
    return 0
  fi
  if [[ -z "${entered_key}" && "${NON_INTERACTIVE}" -eq 0 ]]; then
    printf 'Paste the Gemini Developer API key from your password manager.\n'
    read -r -s -p "GEMINI_API_KEY: " entered_key
    printf '\n'
  fi
  if [[ -z "${entered_key}" ]]; then
    die "A Gemini Developer API key is required." \
      "${INSTALL_DOC}#gemini-api-key"
  fi
  debug "Gemini key supplied; value hidden"
  printf -v "${result_variable}" '%s' "${entered_key}"
}

bootstrap_transfer_secret_is_available() {
  local secret_resource="$1"
  local project_id
  local secret_id
  local expected_prefix
  local secret_state
  local version_id

  project_id="$(state_get '.projectId')"
  secret_id="$(bootstrap_transfer_secret_id)"
  expected_prefix="projects/${project_id}/secrets/${secret_id}/versions/"
  if [[ "${secret_resource}" != "${expected_prefix}"* ]]; then
    return 1
  fi
  version_id="${secret_resource##*/}"
  if [[ ! "${version_id}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if ! secret_state="$(gcloud secrets versions describe "${version_id}" \
    --secret="${secret_id}" \
    --project="${project_id}" \
    --format='value(state)' 2>/dev/null)"; then
    return 1
  fi
  [[ "${secret_state}" == "ENABLED" ]]
}

bootstrap_transfer_secret_id() {
  local script_id

  script_id="$(state_get '.scriptId')"
  if [[ -z "${script_id}" ||
    ! "${script_id}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    die "Installer state has no valid Apps Script ID." \
      "${INSTALL_DOC}#apps-script-project"
  fi
  printf 'drive-utilities-cataloger-%s\n' "${script_id}"
}

ensure_bootstrap_transfer_secret() {
  local project_id="$1"
  local secret_id="$2"
  local attempt
  local ownership_label

  if ownership_label="$(gcloud secrets describe "${secret_id}" \
    --project="${project_id}" \
    --format='value(labels.managed_by)' 2>/dev/null)"; then
    if [[ "${ownership_label}" != "gduc_installer" ]]; then
      die "A non-installer Secret Manager resource uses ${secret_id}." \
        "${INSTALL_DOC}#gemini-api-key"
    fi
    return 0
  fi

  for attempt in 1 2 3; do
    if gcloud secrets create "${secret_id}" \
      --project="${project_id}" \
      --labels='managed_by=gduc_installer' \
      --quiet >/dev/null 2>&1; then
      return 0
    fi
    if ownership_label="$(gcloud secrets describe "${secret_id}" \
      --project="${project_id}" \
      --format='value(labels.managed_by)' 2>/dev/null)"; then
      if [[ "${ownership_label}" != "gduc_installer" ]]; then
        die "A non-installer Secret Manager resource uses ${secret_id}." \
          "${INSTALL_DOC}#gemini-api-key"
      fi
      return 0
    fi
    if [[ "${attempt}" -lt 3 ]]; then
      sleep 5
    fi
  done
  die "Could not create the temporary installer bootstrap handoff." \
    "${INSTALL_DOC}#google-resource-bootstrap"
}

grant_bootstrap_transfer_secret_access() {
  local project_id="$1"
  local secret_id="$2"
  local clasp_account
  local clasp_status

  set +e
  clasp_account="$(authorized_clasp_account "${AUTH_DIR}")"
  clasp_status=$?
  set -e
  if [[ "${clasp_status}" -ne 0 || -z "${clasp_account}" ]]; then
    die "Could not identify the Apps Script owner for secret access." \
      "${INSTALL_DOC}#clasp"
  fi
  if ! gcloud secrets add-iam-policy-binding "${secret_id}" \
    --project="${project_id}" \
    --member="user:${clasp_account}" \
    --role='roles/secretmanager.secretAccessor' \
    --quiet >/dev/null 2>&1; then
    die "Could not grant temporary Secret Manager access to Apps Script." \
      "${INSTALL_DOC}#gemini-api-key"
  fi
}

prepare_bootstrap_transfer_secret() {
  local result_variable="$1"
  local gemini_api_key_required
  local replace_existing=0
  local api_key
  local bootstrap_payload
  local bootstrap_payload_bytes
  local project_id
  local secret_id
  local secret_resource
  local version_id
  local version_name

  gemini_api_key_required="$(state_get '.geminiApiKeyRequired')"
  if [[ "${gemini_api_key_required}" == "true" &&
    -n "${GDUC_GEMINI_API_KEY:-}" ]]; then
    replace_existing=1
  fi

  project_id="$(state_get '.projectId')"
  secret_id="$(bootstrap_transfer_secret_id)"
  secret_resource="$(state_get '.bootstrapSecretVersion')"
  if [[ -n "${secret_resource}" && "${replace_existing}" -eq 0 ]]; then
    evaluate_predicate \
      bootstrap_transfer_secret_is_available "${secret_resource}"
    if [[ "${PREDICATE_STATUS}" -eq 0 ]]; then
      grant_bootstrap_transfer_secret_access "${project_id}" "${secret_id}"
      success "Reusing the private installer bootstrap handoff"
      printf -v "${result_variable}" '%s' "${secret_resource}"
      return 0
    fi
    state_set "bootstrapSecretVersion" ""
  fi

  api_key=""
  if [[ "${gemini_api_key_required}" == "true" ]]; then
    read_gemini_key api_key
  else
    unset GDUC_GEMINI_API_KEY
  fi
  build_bootstrap_payload "${api_key}" bootstrap_payload
  bootstrap_payload_bytes="$(
    printf '%s' "${bootstrap_payload}" | LC_ALL=C wc -c | tr -d ' '
  )"
  if [[ "${bootstrap_payload_bytes}" -gt 60000 ]]; then
    unset api_key bootstrap_payload
    die "Private installer bootstrap data exceeds the safe 60 KB limit." \
      "${INSTALL_DOC}#google-resource-bootstrap"
  fi
  ensure_bootstrap_transfer_secret "${project_id}" "${secret_id}"
  grant_bootstrap_transfer_secret_access "${project_id}" "${secret_id}"
  if ! version_name="$(printf '%s' "${bootstrap_payload}" |
    gcloud secrets versions add "${secret_id}" \
      --project="${project_id}" \
      --data-file=- \
      --format='value(name)' \
      --quiet 2>/dev/null)"; then
    unset api_key
    unset bootstrap_payload
    die "Could not stage the private installer bootstrap data." \
      "${INSTALL_DOC}#google-resource-bootstrap"
  fi
  unset api_key bootstrap_payload
  version_id="${version_name##*/}"
  if [[ ! "${version_id}" =~ ^[0-9]+$ ]]; then
    die "Secret Manager did not return a valid credential version." \
      "${INSTALL_DOC}#gemini-api-key"
  fi
  secret_resource="projects/${project_id}/secrets/${secret_id}/versions/${version_id}"
  state_set "bootstrapSecretVersion" "${secret_resource}"
  success "Staged private installer data through Secret Manager"
  printf -v "${result_variable}" '%s' "${secret_resource}"
}

remove_bootstrap_transfer_secret() {
  local secret_resource="$1"
  local project_id
  local secret_id
  local ownership_label

  if [[ -z "${secret_resource}" ]]; then
    return 0
  fi
  project_id="$(state_get '.projectId')"
  secret_id="$(bootstrap_transfer_secret_id)"
  if ! ownership_label="$(gcloud secrets describe "${secret_id}" \
    --project="${project_id}" \
    --format='value(labels.managed_by)' 2>/dev/null)" ||
    [[ "${ownership_label}" != "gduc_installer" ]]; then
    warning "Refused to delete an unowned Secret Manager resource."
    return 0
  fi
  if gcloud secrets delete "${secret_id}" \
    --project="${project_id}" \
    --quiet >/dev/null 2>&1; then
    state_set "bootstrapSecretVersion" ""
    success "Removed temporary installer bootstrap handoff"
  else
    warning "Temporary private bootstrap data remains in Secret Manager."
    warning "Remove it after confirming installation: ${secret_id}"
  fi
}

discard_rejected_bootstrap_if_needed() {
  local output="$1"
  local secret_resource="$2"

  if [[ "${output}" == *"Gemini Developer API key or model validation failed"* ||
    "${output}" == *"does not support generateContent"* ]]; then
    warning "Gemini validation failed; discarding the staged credential."
    remove_bootstrap_transfer_secret "${secret_resource}"
  fi
}

build_bootstrap_payload() {
  local gemini_api_key="$1"
  local result_variable="$2"
  local serialized_payload

  serialized_payload="$(
    printf '%s' "${gemini_api_key}" |
      jq -Rsc \
        --slurpfile installerState "${STATE_FILE}" \
        --slurpfile automationConfig "${PROJECT_ROOT}/config.local.json" \
        --rawfile agentsPolicy "${PROJECT_ROOT}/AGENTS.example.md" \
        '{
          projectId: $installerState[0].projectId,
          rootFolderId: $installerState[0].rootFolderId,
          spreadsheetId: ($installerState[0].spreadsheetId // ""),
          spreadsheetTitle: $installerState[0].spreadsheetTitle,
          notificationRecipient: $installerState[0].notificationRecipient,
          geminiBackend: $installerState[0].geminiBackend,
          geminiApiKey: .,
          geminiModel: $installerState[0].geminiModel,
          autoVertexFallback: $installerState[0].geminiAutoVertexFallback,
          vertexLocation: $installerState[0].vertexAiLocation,
          automationConfig: $automationConfig[0],
          agentsPolicy: $agentsPolicy,
          timeZone: $installerState[0].timeZone
        }'
  )"
  printf -v "${result_variable}" '%s' "${serialized_payload}"
  unset serialized_payload
}

build_bootstrap_parameters() {
  local bootstrap_secret_version="$1"

  jq -c -n \
    --arg bootstrapSecretVersion "${bootstrap_secret_version}" \
    '[{bootstrapSecretVersion: $bootstrapSecretVersion}]'
}

run_apps_script_bootstrap() {
  local bootstrap_secret_version
  local parameters
  local output
  local run_status
  local script_error
  local spreadsheet_id
  local spreadsheet_url

  prepare_bootstrap_transfer_secret bootstrap_secret_version
  parameters="$(build_bootstrap_parameters "${bootstrap_secret_version}")"

  print_heading "Google resource bootstrap"
  debug "Calling owner-only bootstrapCatalogerInstallation"
  set +e
  output="$("${CLASP[@]}" -A "${AUTH_DIR}" --json \
    run bootstrapCatalogerInstallation \
    --params "${parameters}" 2>&1)"
  run_status=$?
  set -e
  discard_rejected_bootstrap_if_needed \
    "${output}" \
    "${bootstrap_secret_version}"
  if [[ "${run_status}" -ne 0 ]]; then
    printf '%s\n' "${output}" >&2
    die "Apps Script bootstrap failed." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  if ! printf '%s' "${output}" | jq -e '.response.installed == true' \
    >/dev/null 2>&1; then
    script_error="$(printf '%s' "${output}" |
      jq -r '.error.message // .error.details[0].errorMessage // empty' \
        2>/dev/null || true)"
    printf '%s\n' "${output}" >&2
    if [[ -n "${script_error}" ]]; then
      error "Apps Script: ${script_error}"
    fi
    die "Apps Script did not confirm a completed bootstrap." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  spreadsheet_id="$(printf '%s' "${output}" |
    jq -r '.response.spreadsheetId // empty')"
  spreadsheet_url="$(printf '%s' "${output}" |
    jq -r '.response.spreadsheetUrl // empty')"
  if [[ -n "${spreadsheet_id}" ]]; then
    state_set "spreadsheetId" "${spreadsheet_id}"
  fi
  if [[ -n "${spreadsheet_url}" ]]; then
    state_set "spreadsheetUrl" "${spreadsheet_url}"
  fi
  unset parameters
  success "Apps Script properties and Google resources configured"
}

verify_installed_resources() {
  local project_id
  local script_id
  local setup_output
  local subscription_id
  local topic_id

  project_id="$(state_get '.projectId')"
  script_id="$(state_get '.scriptId')"
  topic_id="drive-utilities-events-${script_id}"
  subscription_id="drive-utilities-events-pull-${script_id}"
  print_heading "Final validation"
  if ! gcloud pubsub topics describe "${topic_id}" \
    --project="${project_id}" >/dev/null; then
    die "The installation-specific Pub/Sub topic is unavailable." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  success "Pub/Sub topic"
  if ! gcloud pubsub subscriptions describe "${subscription_id}" \
    --project="${project_id}" \
    --format=json |
    jq -e --arg topic \
      "projects/${project_id}/topics/${topic_id}" '
        .topic == $topic and
        .ackDeadlineSeconds == 300
      ' >/dev/null; then
    die "The Pub/Sub pull subscription topology is incomplete." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  success "Pub/Sub pull subscription topology"
  if ! gcloud pubsub topics get-iam-policy "${topic_id}" \
    --project="${project_id}" \
    --format=json |
    jq -e '
      .bindings[] |
      select(.role == "roles/pubsub.publisher") |
      select((.condition // null) == null) |
      select(
        .members[] ==
        "serviceAccount:drive-api-event-push@system.gserviceaccount.com"
      )
    ' >/dev/null; then
    die "The Drive event publisher permission is missing." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  success "Drive event publisher permission"

  if ! setup_output="$("${CLASP[@]}" -A "${AUTH_DIR}" --json \
    run validateCatalogerInstallation 2>&1)"; then
    printf '%s\n' "${setup_output}" >&2
    die "Apps Script final validation could not run." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  if ! printf '%s' "${setup_output}" |
    jq -e '
      .response.installed == true and
      .response.pubSubConfigured == true and
      .response.workspaceEventActive == true and
      (.response.missingTriggerHandlers | length == 0) and
      (.response.duplicateTriggerHandlers | length == 0)
    ' >/dev/null 2>&1; then
    printf '%s\n' "${setup_output}" >&2
    die "Apps Script setup status is incomplete." \
      "${INSTALL_DOC}#apps-script-execution-errors"
  fi
  success "Apps Script setup status"
}

apply_resume_overrides() {
  local gemini_model="${GDUC_GEMINI_MODEL:-}"
  local vertex_ai_location="${GDUC_VERTEX_AI_LOCATION:-}"

  if [[ -n "${gemini_model}" ]]; then
    evaluate_predicate is_valid_gemini_model "${gemini_model}"
    if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
      die "Invalid Gemini model identifier: ${gemini_model}" \
        "${INSTALL_DOC}#gemini-runtime"
    fi
    state_set "geminiModel" "${gemini_model}"
    success "Updated the pending Gemini model"
  fi
  if [[ -n "${vertex_ai_location}" ]]; then
    evaluate_predicate is_valid_vertex_location "${vertex_ai_location}"
    if [[ "${PREDICATE_STATUS}" -ne 0 ]]; then
      die "Invalid Vertex AI location: ${vertex_ai_location}" \
        "${INSTALL_DOC}#gemini-runtime"
    fi
    state_set "vertexAiLocation" "${vertex_ai_location}"
    success "Updated the pending Vertex AI location"
  fi
}

complete_installation() {
  local client_file="${GDUC_OAUTH_CLIENT_JSON:-}"
  local script_id
  local project_id
  local root_folder_id
  local spreadsheet_url
  local bootstrap_secret_version

  if [[ -z "${client_file}" ]]; then
    prompt_value client_file \
      "Path to the Desktop OAuth client JSON downloaded from Google Cloud" \
      "" \
      ""
  fi
  apply_resume_overrides
  validate_local_config_for_installation
  validate_oauth_client "${client_file}"
  authorize_installer_execution "${client_file}"
  push_apps_script_source "${AUTH_DIR}"
  ensure_api_executable_deployment
  run_apps_script_bootstrap
  verify_installed_resources
  bootstrap_secret_version="$(state_get '.bootstrapSecretVersion')"
  remove_bootstrap_transfer_secret "${bootstrap_secret_version}"

  state_set "phase" "complete"
  script_id="$(state_get '.scriptId')"
  project_id="$(state_get '.projectId')"
  root_folder_id="$(state_get '.rootFolderId')"
  spreadsheet_url="$(state_get '.spreadsheetUrl')"
  rm -rf "${AUTH_DIR}" "${MANAGEMENT_AUTH_DIR}"

  print_heading "Installation complete"
  success "Drive Utilities Cataloger is installed and scheduled."
  printf '  Apps Script: https://script.google.com/home/projects/%s\n' "${script_id}"
  printf '  Cloud project: https://console.cloud.google.com/home/dashboard?project=%s\n' \
    "${project_id}"
  printf '  Drive intake: https://drive.google.com/drive/folders/%s\n' \
    "${root_folder_id}"
  if [[ -n "${spreadsheet_url}" ]]; then
    printf '  Spreadsheet: %s\n' "${spreadsheet_url}"
  fi
  printf '  Next: add a controlled PDF and follow %s#controlled-validation\n' \
    "${INSTALL_DOC}"
}

resume_installation() {
  local bootstrap_secret_version
  local phase

  if [[ ! -f "${STATE_FILE}" ]]; then
    die "No resumable installer state exists. Run make install first." \
      "${INSTALL_DOC}#quick-start"
  fi
  validate_installer_state
  phase="$(state_get '.phase')"
  debug "Resuming installer phase ${phase}"
  case "${phase}" in
    collected | cloud_ready | apps_script_api_required | script_ready)
      continue_initial_install
      ;;
    browser_required)
      complete_installation
      ;;
    complete)
      bootstrap_secret_version="$(state_get '.bootstrapSecretVersion')"
      remove_bootstrap_transfer_secret "${bootstrap_secret_version}"
      rm -rf "${AUTH_DIR}" "${MANAGEMENT_AUTH_DIR}"
      success "Installation is already complete."
      ;;
    *)
      die "Unknown installer phase: ${phase}" \
        "${INSTALL_DOC}#resetting-private-installer-state"
      ;;
  esac
}

reset_installer_state() {
  if [[ ! -d "${STATE_DIR}" && ! -f "${PROJECT_ROOT}/.clasp.json" ]]; then
    success "No private installer state or Apps Script mapping exists."
    return 0
  fi
  confirm \
    "Remove private installer state and .clasp.json? Google resources will remain" \
    "no"
  if [[ "${CONFIRM_RESULT}" -ne 1 ]]; then
    info "Installer state preserved."
    return 0
  fi
  rm -rf "${AUTH_DIR}" "${MANAGEMENT_AUTH_DIR}"
  rm -f "${STATE_FILE}" "${STATE_MARKER}"
  release_installer_lock
  if [[ -d "${STATE_DIR}" ]] && ! rmdir "${STATE_DIR}" 2>/dev/null; then
    warning "Preserved unrecognized files in ${STATE_DIR}."
  fi
  rm -f "${PROJECT_ROOT}/.clasp.json"
  success "Removed private installer state and local Apps Script mapping."
  info "Remote Google resources were not changed."
}

main() {
  parse_arguments "$@"
  cd "${PROJECT_ROOT}"
  validate_state_directory_setting

  case "${MODE}" in
    check)
      run_preflight
      check_clasp_readiness
      exit 0
      ;;
    reset)
      if [[ -d "${STATE_DIR}" || -f "${PROJECT_ROOT}/.clasp.json" ]]; then
        acquire_installer_lock
      fi
      reset_installer_state
      exit 0
      ;;
    install | resume)
      ;;
    *)
      die "Unsupported installer mode: ${MODE}" "${INSTALL_DOC}#quick-start"
      ;;
  esac

  acquire_installer_lock
  run_preflight
  if [[ "${MODE}" == "resume" ]]; then
    resume_installation
    exit 0
  fi

  if [[ -f "${STATE_FILE}" ]]; then
    warning "An incomplete or completed installation state already exists."
    confirm "Resume it now?" "yes"
    if [[ "${CONFIRM_RESULT}" -eq 1 ]]; then
      resume_installation
      exit 0
    fi
    die "Use make install-reset before starting over." \
      "${INSTALL_DOC}#resetting-private-installer-state"
  fi
  if [[ -f "${PROJECT_ROOT}/.clasp.json" ]]; then
    die "This checkout already targets an Apps Script project but has no installer state." \
      "${INSTALL_DOC}#adopting-an-existing-installation"
  fi

  collect_installation_inputs
  continue_initial_install
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  exit 0
fi
