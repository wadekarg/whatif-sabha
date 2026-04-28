#!/usr/bin/env bash
# WhatIfSabha — one-command install + run.
# See docs/superpowers/specs/2026-04-26-run-script-design.md for the design.

set -euo pipefail
unset CDPATH

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

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not found."
    print_node_install_hint
    return 1
  fi
  local version
  version="$(node --version 2>/dev/null | sed 's/^v//')" || true
  if [ -z "$version" ]; then
    fail "Node.js found but 'node --version' failed or produced no output."
    print_node_install_hint
    return 1
  fi
  if ! version_ge "$version" "18"; then
    fail "Node.js $version found, but >= 18 required."
    print_node_install_hint
    return 1
  fi
  success "Node $version"
  return 0
}

print_node_install_hint() {
  case "$PLATFORM" in
    macos) echo "  brew install node" ;;
    linux|wsl)
      case "$DISTRO" in
        debian) echo "  sudo apt install nodejs npm  (note: Ubuntu's apt may have an old version; for Node 20+ see https://github.com/nodesource/distributions)" ;;
        fedora) echo "  sudo dnf install nodejs npm" ;;
        arch)   echo "  sudo pacman -S nodejs npm" ;;
        *)      echo "  Install Node >= 18 via your distro's package manager." ;;
      esac
      ;;
  esac
}

check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    fail "npm not found. (Usually bundled with Node.js — install Node and npm should come with it.)"
    print_node_install_hint
    return 1
  fi
  local version
  version="$(npm --version 2>/dev/null)" || true
  if [ -z "$version" ]; then
    fail "npm found but 'npm --version' failed."
    print_node_install_hint
    return 1
  fi
  success "npm $version"
  return 0
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    fail "git not found."
    case "$PLATFORM" in
      macos)     echo "  xcode-select --install   (or brew install git)" ;;
      linux|wsl) echo "  Install git via your distro's package manager (e.g. sudo apt install git)." ;;
    esac
    return 1
  fi
  return 0
}

check_prereqs() {
  local ok=1
  if ! find_python; then
    fail "Python >= 3.10 not found."
    print_python_install_hint
    ok=0
  else
    success "Python $("$PYTHON_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') ($PYTHON_BIN)"
  fi
  check_node || ok=0
  check_npm  || ok=0
  check_git  || ok=0
  if [ $ok -eq 0 ]; then
    echo
    fail "Install missing prerequisites and re-run ./run.sh"
    exit 1
  fi
}

compute_install_state() {
  mkdir -p .run-cache .run-logs

  # Honor --reinstall before any hash computation so this works even on a
  # corrupted working tree where requirements.txt or package.json is missing.
  if [ "$REINSTALL" = "1" ]; then
    BACKEND_NEEDS_INSTALL=1
    FRONTEND_NEEDS_INSTALL=1
    info "Forced reinstall (--reinstall)"
    : > .run-logs/install.log
    return 0
  fi

  local req_hash pkg_hash cached_req cached_pkg cached_python

  req_hash=$(compute_hash backend/requirements.txt)
  pkg_hash=$(compute_hash frontend/package.json)
  cached_req=$( [ -f .run-cache/requirements.hash ] && cat .run-cache/requirements.hash || echo "" )
  cached_pkg=$( [ -f .run-cache/package.hash ]      && cat .run-cache/package.hash      || echo "" )
  cached_python=$( [ -f .run-cache/python.path ]    && cat .run-cache/python.path       || echo "" )

  # Backend: hash mismatch OR Python interpreter changed OR venv missing
  if [ "$req_hash" != "$cached_req" ] \
     || [ "$cached_python" != "$PYTHON_BIN" ] \
     || [ ! -d backend/venv ]; then
    BACKEND_NEEDS_INSTALL=1
  fi

  # Frontend: hash mismatch OR node_modules missing
  if [ "$pkg_hash" != "$cached_pkg" ] || [ ! -d frontend/node_modules ]; then
    FRONTEND_NEEDS_INSTALL=1
  fi

  if [ "$BACKEND_NEEDS_INSTALL" = "0" ]; then
    success "Backend deps unchanged (skip install)"
  fi
  if [ "$FRONTEND_NEEDS_INSTALL" = "0" ]; then
    success "Frontend deps unchanged (skip install)"
  fi

  # Truncate the install log once if any subinstall will run, so handle_install_failure
  # doesn't tail stale content from a prior run.
  if [ "$BACKEND_NEEDS_INSTALL" = "1" ] || [ "$FRONTEND_NEEDS_INSTALL" = "1" ]; then
    : > .run-logs/install.log
  fi
}

handle_install_failure() {
  local component="$1"  # "backend" or "frontend"
  local log=".run-logs/install.log"
  echo
  fail "Install failed for $component."
  echo

  # Pattern-match the log for known issues. Order matters — most specific first.
  if grep -qE "EBADPLATFORM|Cannot find module '@tailwindcss/oxide" "$log" 2>/dev/null; then
    echo "${BOLD}Likely cause:${RESET} npm platform mismatch (lockfile from a different OS)."
    echo "${BOLD}Fix:${RESET}"
    echo "  rm -rf frontend/node_modules frontend/package-lock.json"
    echo "  ./run.sh --reinstall"
  elif grep -qE "numpy\.dtype size changed|numpy\.core\.multiarray failed" "$log" 2>/dev/null; then
    echo "${BOLD}Likely cause:${RESET} NumPy ABI break (PyTorch built against NumPy 1.x but 2.x is installed)."
    echo "${BOLD}Fix:${RESET}"
    echo "  ./run.sh --reinstall"
  elif grep -qE "unable to get local issuer certificate" "$log" 2>/dev/null; then
    echo "${BOLD}Likely cause:${RESET} macOS SSL certificate issue."
    echo "${BOLD}Fix:${RESET}"
    echo "  pip install --upgrade certifi"
    echo "  ./run.sh --reinstall"
  elif grep -qiE "command line developer tools" "$log" 2>/dev/null; then
    echo "${BOLD}Likely cause:${RESET} Apple's Python stub triggered."
    echo "${BOLD}Fix:${RESET}"
    echo "  xcode-select --install"
  elif grep -qE "No space left on device" "$log" 2>/dev/null; then
    echo "${BOLD}Likely cause:${RESET} Disk is full."
    echo "${BOLD}Fix:${RESET}"
    echo "  Free up at least 5GB (pip + PyTorch needs that much)."
  else
    echo "${BOLD}No matching pattern.${RESET} Last 30 lines of the install log:"
    echo "  ────────────────────────────────────────"
    tail -n 30 "$log" 2>/dev/null | sed 's/^/  /' || true
    echo "  ────────────────────────────────────────"
    echo "Full log: $log"
    echo "README troubleshooting: README.md (search 'Troubleshooting')"
  fi
  echo
  exit 1
}

install_backend() {
  [ "$BACKEND_NEEDS_INSTALL" = "1" ] || return 0

  info "Installing backend dependencies (this takes a few minutes the first time)..."
  [ -d backend ] || { fail "'backend/' directory not found. Are you in the repo root?"; exit 1; }
  cd backend

  # Venv staleness — recreate if the Python interpreter changed since last build
  local cached_python=""
  [ -f ../.run-cache/python.path ] && cached_python=$(cat ../.run-cache/python.path)
  if [ -d venv ] && [ "$cached_python" != "$PYTHON_BIN" ]; then
    info "Python interpreter changed ($cached_python -> $PYTHON_BIN); rebuilding venv"
    rm -rf venv
  fi

  if [ ! -d venv ]; then
    if ! "$PYTHON_BIN" -m venv venv >> ../.run-logs/install.log 2>&1; then
      cd ..
      fail "Failed to create Python venv with $PYTHON_BIN."
      echo "  Common cause: missing 'venv' module."
      case "$PLATFORM" in
        linux|wsl)
          case "$DISTRO" in
            debian) echo "  Fix: sudo apt install python3.12-venv  (or python3-venv)" ;;
            fedora) echo "  Fix: sudo dnf install python3-pip       (venv comes with python3 on fedora)" ;;
            arch)   echo "  Fix: should be bundled — try reinstalling python: sudo pacman -S python" ;;
            *)      echo "  Fix: install your distro's python3-venv package." ;;
          esac
          ;;
        macos) echo "  Fix: reinstall Python: brew reinstall python@3.12" ;;
      esac
      echo "  Last 10 lines of install log:"
      tail -n 10 .run-logs/install.log 2>/dev/null | sed 's/^/    /' || true
      exit 1
    fi
  fi

  # shellcheck disable=SC1091
  # Activate venv. PATH change leaks beyond this function — that's intentional;
  # Task 13's start_services needs python/uvicorn from the venv.
  source venv/bin/activate

  if ! pip install --upgrade pip >> ../.run-logs/install.log 2>&1; then
    cd ..
    handle_install_failure backend
  fi

  if ! pip install -r requirements.txt --upgrade-strategy only-if-needed \
       >> ../.run-logs/install.log 2>&1; then
    cd ..
    handle_install_failure backend
  fi

  if ! { echo "$PYTHON_BIN" > ../.run-cache/python.path \
         && compute_hash requirements.txt > ../.run-cache/requirements.hash; }; then
    cd ..
    fail "Couldn't write to .run-cache/. Check disk space and permissions."
    exit 1
  fi
  cd ..
  success "Backend ready"
}

install_frontend() {
  [ "$FRONTEND_NEEDS_INSTALL" = "1" ] || return 0

  info "Installing frontend dependencies..."
  [ -d frontend ] || { fail "'frontend/' directory not found. Are you in the repo root?"; exit 1; }
  cd frontend

  # Append to the install log started by install_backend (don't truncate again)
  if ! npm install >> ../.run-logs/install.log 2>&1; then
    cd ..
    handle_install_failure frontend
  fi

  if ! compute_hash package.json > ../.run-cache/package.hash; then
    cd ..
    fail "Couldn't write to .run-cache/. Check disk space and permissions."
    exit 1
  fi
  cd ..
  success "Frontend ready"
}

port_in_use() {
  local port="$1"
  # Connect-test via bash's /dev/tcp pseudo-device — owner-agnostic and reliable.
  # If anything is listening on the port (regardless of who owns the listener),
  # the connect succeeds. lsof -t is unreliable because it only shows PIDs the
  # calling user can see, missing listeners owned by other users (e.g. system
  # services running as root). The bash shebang guarantees /dev/tcp support.
  if (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
    return 0
  fi
  # Also probe IPv6 loopback — some services bind only there.
  if (echo > "/dev/tcp/::1/$port") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

check_ports() {
  local conflict=0
  if port_in_use 8001; then
    fail "Port 8001 is in use. WhatIfSabha may already be running."
    echo "  Inspect:  lsof -i:8001"
    echo "  Free it:  lsof -ti:8001 | xargs kill"
    conflict=1
  fi
  if port_in_use 3000; then
    fail "Port 3000 is in use."
    echo "  Inspect:  lsof -i:3000"
    echo "  Free it:  lsof -ti:3000 | xargs kill"
    conflict=1
  fi
  [ $conflict -eq 0 ] || exit 1
}

cleanup() {
  trap '' INT TERM EXIT  # disarm to prevent recursion
  # Only show shutdown messages if there are actual background jobs to kill —
  # otherwise the user sees confusing "Shutting down..." on a normal early exit.
  if ! jobs -p 2>/dev/null | grep -q .; then
    return 0
  fi
  echo
  info "Shutting down..."
  # Kill background jobs and their entire process groups (set -m makes each job its own group)
  kill -TERM %1 %2 2>/dev/null || true
  # Wait up to 5s for graceful shutdown — gives uvicorn time to drain SSE streams
  local i=0
  while [ $i -lt 50 ] && jobs -r 2>/dev/null | grep -q .; do
    sleep 0.1
    i=$((i + 1))
  done
  kill -KILL %1 %2 2>/dev/null || true
  success "Stopped."
}

setup_trap() {
  set -m  # job control mode: each background job gets its own process group
  trap cleanup INT TERM EXIT
}

start_services() {
  [ -d backend ]  || { fail "'backend/' directory not found.";  exit 1; }
  [ -d frontend ] || { fail "'frontend/' directory not found."; exit 1; }
  info "Starting backend on :8001"
  # Truncate per-service logs (install log already truncated by compute_install_state)
  : > .run-logs/backend.log
  : > .run-logs/frontend.log

  (
    cd backend
    # shellcheck disable=SC1091
    source venv/bin/activate
    exec uvicorn app.main:app --port 8001 --reload
  ) 2>&1 | tee .run-logs/backend.log | awk '{print "[backend] "$0; fflush()}' &

  info "Starting frontend on :3000"
  (
    cd frontend
    exec npm run dev
  ) 2>&1 | tee .run-logs/frontend.log | awk '{print "[frontend] "$0; fflush()}' &
}

wait_for_ready() {
  local elapsed=0
  while [ $elapsed -lt 60 ]; do
    if curl -fs -o /dev/null --max-time 1 http://localhost:3000 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -gt 0 ] && [ $((elapsed % 10)) -eq 0 ]; then
      info "Frontend still compiling... (${elapsed}s)"
    fi
  done
  warn "Frontend didn't respond within 60s. It may still come up — check .run-logs/frontend.log"
  return 1
}

open_browser() {
  [ "$NO_OPEN" = "1" ] && return 0
  local url="http://localhost:3000"
  case "$PLATFORM" in
    macos) open "$url" 2>/dev/null || true ;;
    linux) xdg-open "$url" >/dev/null 2>&1 || true ;;
    wsl)
      if command -v wslview >/dev/null 2>&1; then
        wslview "$url" 2>/dev/null || true
      else
        cmd.exe /c "start $url" 2>/dev/null || true
      fi
      ;;
  esac
}

print_banner() {
  echo
  printf "%s═══════════════════════════════════════════%s\n" "$GREEN" "$RESET"
  printf "%s  WhatIfSabha is running!%s\n" "$BOLD" "$RESET"
  printf "  → %shttp://localhost:3000%s\n" "$BLUE" "$RESET"
  echo  "  Press Ctrl+C to stop"
  printf "%s═══════════════════════════════════════════%s\n" "$GREEN" "$RESET"
  echo
}

# ── Main flow ────────────────────────────────────────────────────────────────
main() {
  parse_flags "$@"
  detect_platform
  check_prereqs
  check_ports
  compute_install_state
  install_backend
  install_frontend
  setup_trap
  start_services
  if wait_for_ready; then
    print_banner
    open_browser
  else
    warn "Frontend may not be fully up — banner suppressed. Tail .run-logs/frontend.log to investigate."
  fi
  wait
}

# Only run main when this script is executed directly, not when sourced.
# This lets tests `source run.sh` and call individual functions without firing main.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
