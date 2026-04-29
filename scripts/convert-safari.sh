#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/web-extension"
OUT_DIR="$ROOT_DIR/safari-xcode"

if ! xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  echo "Error: cannot find safari-web-extension-packager."
  echo "Install full Xcode or select it with:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

xcrun safari-web-extension-packager "$EXT_DIR" \
  --project-location "$OUT_DIR" \
  --bundle-identifier "com.qrst1ks4.transjux" \
  --force
