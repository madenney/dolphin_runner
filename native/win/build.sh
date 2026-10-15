#!/usr/bin/env bash
# Cross-compile lunar-hidden-launcher.exe (Windows x64) from Linux.
#
#   ./build.sh            # -> bin/lunar-hidden-launcher.exe + bin/SHA256SUMS
#
# Compiler, first found: $ZIG (a zig binary), `zig` on PATH, then mingw-w64
# ($MINGW_CC or x86_64-w64-mingw32-gcc). The committed binary was built with
# zig 0.13.0 (https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz,
# sha256 d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea,
# unpacked anywhere; nothing is installed). It links only Windows' own DLLs
# (user32, kernel32 and the UCRT that ships with Windows 10+).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin"
mkdir -p "$out"
src=("$here/hidden_launcher.c")
flags=(-O2 -municode -Wall -Wextra -s -Wl,--subsystem,windows)
zig="${ZIG:-$(command -v zig || true)}"
if [ -n "$zig" ]; then
  "$zig" cc -target x86_64-windows-gnu "${flags[@]}" -o "$out/lunar-hidden-launcher.exe" "${src[@]}" "$here/hidden_launcher.rc" -luser32 -lkernel32
  rm -f "$out/lunar-hidden-launcher.pdb"
else
  cc="${MINGW_CC:-x86_64-w64-mingw32-gcc}"
  if ! command -v "$cc" >/dev/null 2>&1; then
    echo "error: no zig and no $cc. Set ZIG=/path/to/zig (see above), or build on Windows with build.bat." >&2
    exit 1
  fi
  windres="${MINGW_WINDRES:-x86_64-w64-mingw32-windres}"
  "$windres" "$here/hidden_launcher.rc" -O coff -o "$out/hidden_launcher.res.o"
  "$cc" "${flags[@]}" -o "$out/lunar-hidden-launcher.exe" "${src[@]}" "$out/hidden_launcher.res.o" -luser32 -lkernel32
  rm -f "$out/hidden_launcher.res.o"
fi
(cd "$out" && sha256sum lunar-hidden-launcher.exe > SHA256SUMS)
cat "$out/SHA256SUMS"
