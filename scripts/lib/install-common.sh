#!/usr/bin/env bash

# Shared, side-effect-free helpers for the installer and its tests.

extract_google_resource_id() {
  local input_value="${1:-}"

  if [[ "${input_value}" =~ /folders/([A-Za-z0-9_-]{20,}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "${input_value}" =~ /d/([A-Za-z0-9_-]{20,}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "${input_value}" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
    printf '%s\n' "${input_value}"
    return 0
  fi
  return 1
}

is_valid_project_id() {
  local project_id="${1:-}"

  [[ "${project_id}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]
}

is_valid_email() {
  local email="${1:-}"

  [[ "${email}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

is_supported_locale() {
  local locale="${1:-}"

  [[ "${locale}" == "en" || "${locale}" == "it" ]]
}

is_valid_time_zone() {
  local time_zone="${1:-}"

  node -e '
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: process.argv[1] }).format();
    } catch (error) {
      process.exit(1);
    }
  ' "${time_zone}" >/dev/null 2>&1
}

is_valid_gemini_model() {
  local model="${1:-}"

  [[ "${model}" =~ ^[a-z0-9][a-z0-9._-]+$ ]]
}

is_valid_vertex_location() {
  local location="${1:-}"

  [[ "${location}" == "global" ||
    "${location}" =~ ^[a-z]+-[a-z0-9-]+[0-9]$ ]]
}

is_valid_gemini_mode() {
  local mode="${1:-}"

  gemini_mode_metadata "${mode}" >/dev/null
}

gemini_mode_metadata() {
  local mode="${1:-}"

  case "${mode}" in
    gemini_api)
      printf 'gemini_api\ttrue\tfalse\tfalse\n'
      ;;
    vertex_ai)
      printf 'vertex_ai\tfalse\ttrue\tfalse\n'
      ;;
    gemini_api_with_vertex_fallback)
      printf 'gemini_api\ttrue\ttrue\ttrue\n'
      ;;
    *)
      return 1
      ;;
  esac
}

major_version() {
  local version_text="${1:-}"

  printf '%s\n' "${version_text}" |
    sed -E 's/^[^0-9]*([0-9]+).*/\1/'
}

open_url() {
  local url="$1"

  case "$(uname -s)" in
    Darwin)
      open "${url}" >/dev/null 2>&1
      ;;
    Linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${url}" >/dev/null 2>&1
      else
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac
}
