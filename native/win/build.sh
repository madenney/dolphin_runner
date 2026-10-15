#!/usr/bin/env bash
# Cross-compile the experimental Windows hidden-desktop launcher with mingw-w64.
# EXPERIMENTAL — see hidden_launcher.c. Not built or run in CI yet; no system
# packages are installed by this script.
#
#   ./build.sh            # -> dist/lunar-hidden-launcher.exe (x86_64)
#
# Needs x86_64-w64-mingw32-gcc on PATH (Debian/Ubuntu: gcc-mingw-w64-x86-64).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cc="${MINGW_CC:-x86_64-w64-mingw32-gcc}"
if ! command -v "$cc" >/dev/null 2>&1; then
  echo "error: $cc not found. Install mingw-w64 (gcc-mingw-w64-x86-64) or build on Windows (build.bat)." >&2
  exit 1
fi
mkdir -p "$here/dist"
"$cc" -O2 -municode -o "$here/dist/lunar-hidden-launcher.exe" "$here/hidden_launcher.c" -luser32 -ladvapi32
echo "built: $here/dist/lunar-hidden-launcher.exe"
