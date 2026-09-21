#!/usr/bin/env bash
# Starts the built application twice against the same user-data directory and
# verifies what "it works" has to mean for the first vertical slice:
#
#   phase 1  window opens, React shell mounts, preload bridge reaches the main
#            process, a workspace and session are created, a message streams
#            back, the conversation is persisted, usage is reported, and the
#            palette, usage popover, settings and providers views respond
#   phase 2  after a real restart the conversation is still there and the
#            provider session is resumed rather than recreated
#
# Uses Xvfb when no display is available, so this runs in CI and containers.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f apps/desktop/out/main/index.js ]; then
  echo "Build output missing. Run: pnpm build"
  exit 1
fi

ELECTRON_BIN="node_modules/.bin/electron"
WORK_DIR="$(mktemp -d)"
DATA_DIR="$WORK_DIR/user-data"
WORKSPACE_DIR="$WORK_DIR/workspace"
LOG_FILE="$WORK_DIR/startup-check.log"
mkdir -p "$DATA_DIR" "$WORKSPACE_DIR"

trap 'rm -rf "$WORK_DIR"' EXIT

ELECTRON_ARGS=(apps/desktop/out/main/index.js)
if [ "$(id -u)" = "0" ]; then
  # Chromium refuses its own sandbox as root; this affects the check only.
  ELECTRON_ARGS=(--no-sandbox "${ELECTRON_ARGS[@]}")
fi

RUNNER=()
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  RUNNER=(xvfb-run -a)
fi

run_phase() {
  local mode="$1"
  echo "--- startup check: $mode ---"
  set +e
  AI_WORKBENCH_STARTUP_CHECK=1 \
  AI_WORKBENCH_CHECK_MODE="$mode" \
  AI_WORKBENCH_CHECK_DATA_DIR="$DATA_DIR" \
  AI_WORKBENCH_CHECK_WORKSPACE="$WORKSPACE_DIR" \
    "${RUNNER[@]}" "$ELECTRON_BIN" "${ELECTRON_ARGS[@]}" >"$LOG_FILE" 2>&1
  local status=$?
  set -e

  grep -oE '"msg":"(PASS|FAIL)[^"]*"' "$LOG_FILE" | sed 's/"msg":"//; s/"$//' || true

  if [ $status -ne 0 ]; then
    echo "Startup check ($mode) failed with exit $status"
    grep -v 'dbus\|XIO:\|X server\|GPU\|Fontconfig' "$LOG_FILE" | tail -30
    exit $status
  fi
}

run_phase create
run_phase resume

echo "Startup check passed."
