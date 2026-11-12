#!/usr/bin/env bash
# Tests the Mac app's logic that needs no window (macos/Core.swift) with a small swiftc-built test program.
#   ./scripts/test-mac-app.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo "the Mac app builds and tests on macOS only" >&2; exit 1; }
out="$root/dist/macos-tests"
mkdir -p "$out"
xcrun swiftc -module-cache-path "$out/swift-cache" -O "$root/macos/Core.swift" "$root/macos/Tests/main.swift" -o "$out/core-tests"
"$out/core-tests"
