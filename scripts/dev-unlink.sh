#!/usr/bin/env bash
# Removes the dev-link wrapper + marker written by scripts/dev-link.sh.
#
#   ./scripts/dev-unlink.sh
#
# Restores nothing — if you want a production install back, re-run
# scripts/install.sh. This script only removes what dev-link.sh itself
# created, and refuses to touch anything that doesn't look like its own
# wrapper (e.g. a production install's symlink).
set -euo pipefail

BIN_DIR="${UPSTAGE_BIN_DIR:-$HOME/.local/bin}"
WRAPPER="$BIN_DIR/upstage"
MARKER_FILE="$HOME/.upstage-cli/dev-link.json"
MARKER_TAG="upstage-cli dev-link wrapper"

removed_any=0

if [[ -e "$WRAPPER" ]]; then
  if [[ -L "$WRAPPER" ]]; then
    echo "warning: $WRAPPER is a symlink (looks like a production install, not a dev-link wrapper) — leaving it alone." >&2
  elif [[ -f "$WRAPPER" ]] && grep -qF "$MARKER_TAG" "$WRAPPER" 2>/dev/null; then
    rm -f "$WRAPPER"
    echo "Removed: $WRAPPER"
    removed_any=1
  else
    echo "warning: $WRAPPER exists but doesn't look like a dev-link wrapper — leaving it alone." >&2
  fi
else
  echo "No wrapper found at $WRAPPER."
fi

if [[ -f "$MARKER_FILE" ]]; then
  rm -f "$MARKER_FILE"
  echo "Removed: $MARKER_FILE"
  removed_any=1
else
  echo "No dev-link marker found at $MARKER_FILE."
fi

if [[ $removed_any -eq 0 ]]; then
  echo "Nothing to unlink."
fi
