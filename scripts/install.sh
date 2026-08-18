#!/usr/bin/env bash
# upstage-cli standalone installer (macOS/Linux). Windows: download the
# upstage-windows-x64.zip asset from the latest GitHub Release instead.
#
#   curl -fsSL https://raw.githubusercontent.com/VectorSophie/upstage-cli/master/scripts/install.sh | bash
#
# No Bun/Node install required — this downloads a self-contained compiled
# executable (see scripts/package-binary.mjs) for your platform.
set -euo pipefail

REPO="VectorSophie/upstage-cli"
INSTALL_DIR="${UPSTAGE_INSTALL_DIR:-$HOME/.local/share/upstage-cli}"
BIN_DIR="${UPSTAGE_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) echo "Unsupported OS: $os (Windows: download upstage-windows-x64.zip from the Releases page instead)" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="upstage-${platform}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

echo "Downloading ${asset}..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$asset"

echo "Installing to ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$tmp"
mv "$tmp/upstage-${platform}-${arch}"/* "$INSTALL_DIR/"

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/upstage" "$BIN_DIR/upstage"
chmod +x "$INSTALL_DIR/upstage"

echo "Installed: $BIN_DIR/upstage -> $INSTALL_DIR/upstage"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "Run 'upstage --help' to get started."
