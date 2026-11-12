#!/usr/bin/env bash
# Packs dist/Feedback Graph.app (./scripts/build-mac-app.sh builds it first when missing) into
# dist/Feedback-Graph-<version>.dmg: the app beside an Applications link, to drag it into.
#   ./scripts/build-dmg.sh [out-dir]
# With FG_SIGN_IDENTITY set the disk image is signed too; notarize the app before packing it (scripts/notarize-mac-app.sh).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist}"
[ "$(uname -s)" = Darwin ] || { echo "the disk image builds on macOS only" >&2; exit 1; }
app="$out/Feedback Graph.app"
[ -d "$app" ] || "$root/scripts/build-mac-app.sh" "$out" >/dev/null
out="$(cd "$out" && pwd)"
app="$out/Feedback Graph.app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
dmg="$out/Feedback-Graph-$version.dmg"

stage="$(mktemp -d "${TMPDIR:-/tmp}/fg-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Feedback Graph.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "Feedback Graph $version" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
if [ -n "${FG_SIGN_IDENTITY:-}" ]; then codesign --force --timestamp --sign "$FG_SIGN_IDENTITY" "$dmg"; fi
hdiutil verify -quiet "$dmg"
echo "$dmg"
