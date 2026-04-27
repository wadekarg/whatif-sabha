#!/usr/bin/env bash
# WhatIfSabha — one-command install + run.
# See docs/superpowers/specs/2026-04-26-run-script-design.md for the design.

set -euo pipefail

# ── Colors (TTY-aware) ────────────────────────────────────────────────────────
# shellcheck disable=SC2034  # color vars used by helper functions added in later tasks
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
# shellcheck disable=SC2034  # globals used by phase functions added in later tasks
PLATFORM=""        # macos | linux | wsl
# shellcheck disable=SC2034
DISTRO=""          # debian | ubuntu | fedora | arch | unknown (linux/wsl only)
# shellcheck disable=SC2034
PYTHON_BIN=""      # path to python3.x interpreter
# shellcheck disable=SC2034
NO_OPEN=0
# shellcheck disable=SC2034
REINSTALL=0
# shellcheck disable=SC2034
BACKEND_NEEDS_INSTALL=0
# shellcheck disable=SC2034
FRONTEND_NEEDS_INSTALL=0

# Subsequent phase functions get appended below.

# ── Main flow ────────────────────────────────────────────────────────────────
main() {
  echo "WhatIfSabha launcher"
  # Phase calls get added here as we implement them.
}

# Only run main when this script is executed directly, not when sourced.
# This lets tests `source run.sh` and call individual functions without firing main.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
