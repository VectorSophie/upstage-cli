#!/usr/bin/env bash
# upstage-cli standalone installer (macOS/Linux). Windows: download the
# upstage-windows-x64.zip asset from the latest GitHub Release instead.
#
#   curl -fsSL https://raw.githubusercontent.com/VectorSophie/upstage-cli/master/scripts/install.sh | bash
#
# No Bun/Node install required — this downloads a self-contained compiled
# executable (see scripts/package-binary.mjs) for your platform.
#
# Env vars:
#   UPSTAGE_VERSION        Release tag to install (e.g. "v3.2.0"). Defaults to
#                           "latest". Setting this explicitly also disables
#                           the "looks like a downgrade" guard below (§7.19 #4)
#                           — you asked for this version on purpose.
#   UPSTAGE_INSTALL_DIR     Where the binary + assets land. Default:
#                           $HOME/.local/share/upstage-cli
#   UPSTAGE_BIN_DIR         Where the `upstage` symlink is created. Default:
#                           $HOME/.local/bin
#   UPSTAGE_RELEASE_BASE_URL  Test-only override of "https://github.com/<repo>"
#                           (e.g. a local fixture HTTP server). Not an
#                           end-user-facing knob — exists purely so
#                           tests/m34-install-script.test.mjs can exercise
#                           this script's download/verify/swap logic without
#                           touching the real network.
#   UPSTAGE_INSTALL_PLATFORM / UPSTAGE_INSTALL_ARCH  Test-only overrides of
#                           the `uname`-derived platform/arch, for the same
#                           reason as UPSTAGE_RELEASE_BASE_URL (lets the test
#                           suite force e.g. linux/x64 even when the CI/dev
#                           host running the test is a different OS).
#
# Flags:
#   --force   Skip the confirmation prompts in the "existing install looks
#             different" guard below (§7.19 #4) and proceed unconditionally.
set -euo pipefail

REPO="VectorSophie/upstage-cli"
INSTALL_DIR="${UPSTAGE_INSTALL_DIR:-$HOME/.local/share/upstage-cli}"
BIN_DIR="${UPSTAGE_BIN_DIR:-$HOME/.local/bin}"

GITHUB_BASE="https://github.com/${REPO}"
BASE_URL="${UPSTAGE_RELEASE_BASE_URL:-$GITHUB_BASE}"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: $0 [--force]"
      echo "Installs upstage-cli as a standalone binary into \$UPSTAGE_INSTALL_DIR,"
      echo "symlinked from \$UPSTAGE_BIN_DIR. --force skips the existing-install"
      echo "confirmation prompts (dev-link wrapper present / apparent downgrade)."
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# --- §7.19 #1: UPSTAGE_VERSION override -------------------------------------
# Track whether the caller set this explicitly (even to "latest") vs. us
# defaulting it — the downgrade guard below only fires on the *implicit*
# default, since an explicit version is the user's own informed choice.
VERSION_EXPLICIT=0
if [[ -n "${UPSTAGE_VERSION+set}" ]]; then VERSION_EXPLICIT=1; fi
VERSION="${UPSTAGE_VERSION:-latest}"

# --- platform/arch detection (with test-only overrides) ---------------------
platform="${UPSTAGE_INSTALL_PLATFORM:-}"
arch="${UPSTAGE_INSTALL_ARCH:-}"

if [[ -z "$platform" ]]; then
  os=$(uname -s)
  case "$os" in
    Linux) platform="linux" ;;
    Darwin) platform="darwin" ;;
    *) echo "Unsupported OS: $os (Windows: download upstage-windows-x64.zip from the Releases page instead)" >&2; exit 1 ;;
  esac
fi

if [[ -z "$arch" ]]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
fi

asset="upstage-${platform}-${arch}.tar.gz"

if [[ "$VERSION" == "latest" ]]; then
  url="${BASE_URL}/releases/latest/download/${asset}"
else
  url="${BASE_URL}/releases/download/${VERSION}/${asset}"
fi

# --- §7.19 #2: checksum contract ---------------------------------------------
# Checksum filename/format contract (pinned here AND in
# .github/workflows/release.yml's build-binaries job "Generate checksum"
# step — keep both in sync if either changes):
#   For an archive published as "<asset>", the release also publishes
#   "<asset>.sha256" alongside it, containing a `sha256sum`-compatible line
#   ("<hex digest>  <asset>\n"). We only read the first whitespace-separated
#   field, so `sha256sum`- and `shasum -a 256`-generated lines both work.
checksum_asset="${asset}.sha256"
checksum_url="${url}.sha256"

verify_checksum() {
  local file="$1" sumfile="$2" expected actual
  expected=$(awk '{print $1}' "$sumfile" | head -n1)
  if [[ -z "$expected" ]]; then
    echo "error: checksum file is empty or malformed: $sumfile" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  elif command -v openssl >/dev/null 2>&1; then
    actual=$(openssl dgst -sha256 "$file" | awk '{print $NF}')
  else
    echo "error: no sha256 tool found (need sha256sum, shasum, or openssl) — cannot verify checksum" >&2
    return 1
  fi
  if [[ "$expected" != "$actual" ]]; then
    echo "error: checksum mismatch for $(basename "$file")" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi
}

# --- §7.19 #4 detection helpers ----------------------------------------------
# The dev-link marker tag/path must match scripts/dev-link.sh's own
# $MARKER_TAG (written into the $BIN_DIR/upstage wrapper it creates) and
# src/cli/lib/install-type.mjs's getDevLinkMarkerPath() — keep all three in
# sync if any changes.
DEV_LINK_MARKER_TAG="upstage-cli dev-link wrapper"
DEV_LINK_MARKER_FILE="$HOME/.upstage-cli/dev-link.json"

is_dev_link_wrapper() {
  [[ -e "$BIN_DIR/upstage" && ! -L "$BIN_DIR/upstage" && -f "$BIN_DIR/upstage" ]] || return 1
  grep -qF "$DEV_LINK_MARKER_TAG" "$BIN_DIR/upstage" 2>/dev/null
}

# Numeric-segment version comparison (handles "3.2.0"/"v3.2.0" style
# versions; a missing segment on either side is treated as 0). Returns
# success (0) if $1 > $2.
version_gt() {
  local a="${1#v}" b="${2#v}"
  local IFS=.
  local -a pa=($a) pb=($b)
  local len=${#pa[@]} i
  if (( ${#pb[@]} > len )); then len=${#pb[@]}; fi
  for ((i = 0; i < len; i++)); do
    local na="${pa[i]:-0}" nb="${pb[i]:-0}"
    na="${na%%[^0-9]*}"; nb="${nb%%[^0-9]*}"
    na="${na:-0}"; nb="${nb:-0}"
    if (( 10#$na > 10#$nb )); then return 0; fi
    if (( 10#$na < 10#$nb )); then return 1; fi
  done
  return 1
}

# Prompts y/N on a real TTY; on a non-interactive stdin (e.g. `curl | bash`,
# or a test harness) there is no way to ask, so this conservatively answers
# "no" — the caller must pass --force to proceed unattended.
confirm() {
  if [[ ! -t 0 ]]; then
    return 1
  fi
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "Downloading ${asset} (version: ${VERSION})..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$asset"
curl -fsSL "$checksum_url" -o "$tmp/$checksum_asset"

echo "Verifying checksum..."
if ! verify_checksum "$tmp/$asset" "$tmp/$checksum_asset"; then
  echo "Checksum verification failed for ${asset} — refusing to install." >&2
  exit 1
fi

# --- §7.19 #3: extract + smoke-test in a fresh temp dir, BEFORE touching
# $INSTALL_DIR ------------------------------------------------------------
extract_dir="$tmp/extracted"
mkdir -p "$extract_dir"
tar -xzf "$tmp/$asset" -C "$extract_dir"

staged="$extract_dir/upstage-${platform}-${arch}"
new_bin="$staged/upstage"
if [[ ! -f "$new_bin" ]]; then
  echo "error: archive did not contain the expected upstage-${platform}-${arch}/upstage" >&2
  exit 1
fi
chmod +x "$new_bin"

echo "Verifying the extracted binary runs..."
new_version_output=""
if ! new_version_output=$("$new_bin" --version 2>&1); then
  echo "error: extracted binary failed a --version smoke test — refusing to install." >&2
  echo "$new_version_output" >&2
  exit 1
fi
new_version=$(printf '%s' "$new_version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*' | head -n1)

# --- §7.19 #4: refuse to silently clobber a different kind of install -------
if is_dev_link_wrapper && [[ $FORCE -ne 1 ]]; then
  echo "warning: $BIN_DIR/upstage looks like a development dev-link wrapper (from scripts/dev-link.sh), not a standalone install." >&2
  if [[ -f "$DEV_LINK_MARKER_FILE" ]]; then
    echo "  dev-link marker: $DEV_LINK_MARKER_FILE" >&2
  fi
  if ! confirm "Overwrite the dev-link wrapper with a standalone install?"; then
    echo "Aborting without changing anything. Re-run with --force to overwrite the dev-link wrapper." >&2
    exit 1
  fi
fi

if [[ -x "$INSTALL_DIR/upstage" && $VERSION_EXPLICIT -eq 0 && $FORCE -ne 1 ]]; then
  old_version_output=$("$INSTALL_DIR/upstage" --version 2>/dev/null || true)
  old_version=$(printf '%s' "$old_version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*' | head -n1)
  if [[ -n "$old_version" && -n "$new_version" ]] && version_gt "$old_version" "$new_version"; then
    echo "warning: the currently installed upstage-cli ($old_version) looks newer than the version about to be installed ($new_version)." >&2
    echo "  (installing 'latest' with no explicit UPSTAGE_VERSION override — this looks like a downgrade.)" >&2
    if ! confirm "Continue anyway?"; then
      echo "Aborting without changing anything. Re-run with --force, or set UPSTAGE_VERSION explicitly, to proceed." >&2
      exit 1
    fi
  fi
fi

echo "Installing to ${INSTALL_DIR}..."
mkdir -p "$(dirname "$INSTALL_DIR")"

# Atomic swap: move the OLD install aside first (if any), move the NEW one
# into place, and only remove the old one once the swap has succeeded — never
# `rm -rf "$INSTALL_DIR"` up front, so a failed/interrupted install can't
# leave the user with nothing installed.
swap_aside=""
if [[ -e "$INSTALL_DIR" ]]; then
  swap_aside="${INSTALL_DIR}.old.$$"
  mv "$INSTALL_DIR" "$swap_aside"
fi
if ! mv "$staged" "$INSTALL_DIR"; then
  echo "error: failed to move the new install into place." >&2
  if [[ -n "$swap_aside" ]]; then
    echo "restoring the previous install from $swap_aside" >&2
    mv "$swap_aside" "$INSTALL_DIR"
  fi
  exit 1
fi
if [[ -n "$swap_aside" ]]; then
  rm -rf "$swap_aside"
fi

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/upstage" "$BIN_DIR/upstage"
chmod +x "$INSTALL_DIR/upstage"

echo "Installed: $BIN_DIR/upstage -> $INSTALL_DIR/upstage"

# --- §7.19 #5: PATH diagnosis via `command -v`, not a $PATH string-match ----
if resolved=$(command -v upstage 2>/dev/null); then
  echo "PATH check: 'upstage' resolves to $resolved"
  if [[ "$resolved" != "$BIN_DIR/upstage" ]]; then
    echo "Note: a different 'upstage' ($resolved) takes precedence on your PATH over the one just installed ($BIN_DIR/upstage)." >&2
  fi
else
  echo "Note: $BIN_DIR is not on your PATH ('upstage' not found via command -v). Add this to your shell profile:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi

echo "Run 'upstage --help' to get started."
