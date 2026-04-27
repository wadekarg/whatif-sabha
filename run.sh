#!/usr/bin/env bash
# WhatIfSabha — one-command install + run.
# See docs/superpowers/specs/2026-04-26-run-script-design.md for the design.

set -euo pipefail

# ── Colors (TTY-aware) ────────────────────────────────────────────────────────
# shellcheck disable=SC2034  # BOLD forward-declared; used by handle_install_failure and print_banner (later tasks)
if [ -t 1 ]; then
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

info()    { printf "%s→%s %s\n" "$BLUE" "$RESET" "$*"; }
success() { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn()    { printf "%s⚠%s %s\n" "$YELLOW" "$RESET" "$*"; }
fail()    { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; }

# Repo root = directory containing this script
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ── Globals (populated by phase functions) ───────────────────────────────────
# shellcheck disable=SC2034  # all globals are forward-declared; populated by phase functions in later tasks
{ PLATFORM=""        # macos | linux | wsl
  DISTRO=""          # debian | ubuntu | fedora | arch | unknown (linux/wsl only)
  PYTHON_BIN=""      # path to python3.x interpreter
  NO_OPEN=0
  REINSTALL=0
  BACKEND_NEEDS_INSTALL=0
  FRONTEND_NEEDS_INSTALL=0
}

# Subsequent phase functions get appended below.

parse_flags() {
  while [ $# -gt 0 ]; do
    # shellcheck disable=SC2034  # REINSTALL/NO_OPEN used by later phase functions
    case "$1" in
      --reinstall) REINSTALL=1 ;;
      --no-open)   NO_OPEN=1 ;;
      -h|--help)
        cat <<'EOF'
Usage: ./run.sh [--reinstall] [--no-open] [--help]

  --reinstall   Force pip and npm install even if dependency hashes match.
                Use this after `git pull` brings new deps, or if a previous
                install was interrupted.
  --no-open     Don't open the browser automatically. URL is still printed.
  --help        Show this help and exit.
EOF
        exit 0
        ;;
      *)
        fail "Unknown flag: $1"
        echo "Run './run.sh --help' for usage." >&2
        exit 2
        ;;
    esac
    shift
  done
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="macos" ;;
    Linux)
      if [ -r /proc/version ] && grep -qi "microsoft" /proc/version; then
        PLATFORM="wsl"
      else
        PLATFORM="linux"
      fi
      # Detect distro for prereq install messages
      if [ -r /etc/os-release ]; then
        # Read only the ID and ID_LIKE fields — sourcing the file pollutes our
        # namespace with NAME/VERSION/etc. and risks collisions with later-task globals.
        local _id _id_like _matched
        _id=$(grep -m1 '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
        _id_like=$(grep -m1 '^ID_LIKE=' /etc/os-release | cut -d= -f2 | tr -d '"')
        _matched=""
        # Try primary ID first, then each token in ID_LIKE for derivatives.
        for _candidate_id in "$_id" $_id_like; do
          case "$_candidate_id" in
            debian|ubuntu|linuxmint|pop) DISTRO="debian"; _matched=1; break ;;
            fedora|rhel|centos)          DISTRO="fedora"; _matched=1; break ;;
            arch|manjaro)                DISTRO="arch";   _matched=1; break ;;
          esac
        done
        if [ -z "$_matched" ]; then
          if [ -z "$_id" ]; then
            DISTRO="unknown"
          else
            DISTRO="$_id"
            warn "Unrecognised distro '$_id' (ID_LIKE='$_id_like') — generic install hints will be shown."
          fi
        fi
      else
        DISTRO="unknown"
      fi
      ;;
    *)
      fail "Unsupported platform: $(uname -s). This script supports macOS, Linux, and WSL."
      exit 1
      ;;
  esac
  success "Detected platform: $PLATFORM${DISTRO:+ ($DISTRO)}"
}

compute_hash() {
  # Compute sha256 of the file at $1 and print just the hex digest.
  # macOS lacks sha256sum; ships shasum -a 256 instead.
  if [ -z "${1:-}" ] || [ ! -f "$1" ]; then
    fail "compute_hash: file not found or empty path: '${1:-}'"
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "Neither sha256sum nor shasum found. Cannot compute file hashes."
    exit 1
  fi
}

version_ge() {
  # Returns 0 if version $1 >= version $2, else 1.
  # Versions are dotted strings like "3.12.7" or "20.10.0".
  # Implementation: sort -V, take the lower one, check it's $2.
  #
  # Behavior probe: confirm sort -V actually does version-aware ordering
  # (and didn't silently fall back to lexicographic on systems without GNU sort).
  # Probe runs only the first time; result cached in _SORT_V_OK.
  if [ -z "${_SORT_V_OK:-}" ]; then
    if [ "$(printf '1.10\n1.2\n' | sort -V 2>/dev/null | head -n1)" = "1.2" ]; then
      _SORT_V_OK=1
    else
      fail "sort -V is not supported (or degraded to lexicographic) on this system."
      echo "  This script needs GNU sort or macOS >= 10.13. On older macOS:" >&2
      echo "    brew install coreutils  (then retry — gsort/-V will be available)" >&2
      exit 1
    fi
  fi
  local lower
  lower=$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)
  [ "$lower" = "$2" ]
}

find_python() {
  # Try interpreters in priority order; pick the first that's >= 3.10.
  # This handles Homebrew (which installs python3.12 but may not symlink python3),
  # Apple's stub at /usr/bin/python3, and Anaconda hijacks (we honor whatever's
  # first in PATH if it satisfies the version).
  local candidates=("python3.13" "python3.12" "python3.11" "python3.10" "python3")
  local candidate version stderr_capture
  for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      # Capture stderr to detect Apple's "command line developer tools" stub
      stderr_capture=$("$candidate" -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>&1) || true
      if echo "$stderr_capture" | grep -qiE "command line developer tools|xcrun: error|xcode-select"; then
        fail "Apple's Python stub triggered. Install Xcode Command Line Tools first:"
        echo "  xcode-select --install"
        exit 1
      fi
      version=$(echo "$stderr_capture" | grep -E '^[0-9]+\.[0-9]+$' | head -n1)
      if [ -n "$version" ]; then
        if version_ge "$version" "3.10"; then
          PYTHON_BIN=$(command -v "$candidate")
          return 0
        fi
      fi
    fi
  done
  return 1
}

print_python_install_hint() {
  case "$PLATFORM" in
    macos)
      if ! command -v brew >/dev/null 2>&1; then
        echo "  Install Homebrew first: https://brew.sh"
        echo "  Then: brew install python@3.12"
      else
        echo "  brew install python@3.12"
      fi
      ;;
    linux|wsl)
      case "$DISTRO" in
        debian) echo "  sudo apt update && sudo apt install python3.12 python3.12-venv" ;;
        fedora) echo "  sudo dnf install python3.12 python3.12-pip" ;;
        arch)   echo "  sudo pacman -S python python-pip" ;;
        *)      echo "  Install Python >= 3.10 via your distro's package manager." ;;
      esac
      ;;
  esac
}

check_prereqs() {
  if ! find_python; then
    fail "Python >= 3.10 not found."
    print_python_install_hint
    exit 1
  fi
  success "Python $("$PYTHON_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') ($PYTHON_BIN)"
}

# ── Main flow ────────────────────────────────────────────────────────────────
main() {
  parse_flags "$@"
  detect_platform
  check_prereqs
  echo "Done."
}

# Only run main when this script is executed directly, not when sourced.
# This lets tests `source run.sh` and call individual functions without firing main.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
