#!/usr/bin/env bash
# Builds the menu bar companion into dist/Feedback Graph.app: macos/*.swift compiled with swiftc (no Xcode project) for
# Apple silicon and Intel, the icon rendered from macos/AppIcon.svg. Ad hoc signed, for this Mac, unless FG_SIGN_IDENTITY
# names a Developer ID Application identity (then scripts/notarize-mac-app.sh can notarize it).
#   ./scripts/build-mac-app.sh [out-dir]
# Needs macOS 14 or newer with the Xcode Command Line Tools (xcode-select --install). The app runs on macOS 13 or newer.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist}"
[ "$(uname -s)" = Darwin ] || { echo "the Mac app builds on macOS only" >&2; exit 1; }
command -v xcrun >/dev/null 2>&1 || { echo "missing: the Xcode Command Line Tools (xcode-select --install)" >&2; exit 1; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# The app's version is the newest CHANGELOG section's: "## 0.8.1 (2026-11-11)" builds 0.8.1.
version="$(sed -n 's/^## \([0-9][0-9.]*\).*/\1/p' "$root/CHANGELOG.md" | head -n 1)"
: "${version:?CHANGELOG.md has no ## <version> heading}"

app="$out/Feedback Graph.app"
work="$out/macos-build"
# The compiled system modules (AppKit, WebKit) stay in $out/swift-cache: building them for each architecture takes minutes.
rm -rf "$app" "$work"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$work"

for arch in arm64 x86_64; do
  xcrun swiftc -module-cache-path "$out/swift-cache" -O -parse-as-library -target "$arch-apple-macosx13.0" \
    "$root/macos/Core.swift" "$root/macos/App.swift" \
    -framework AppKit -framework ServiceManagement -framework WebKit -o "$work/FeedbackGraph-$arch"
done
lipo -create "$work/FeedbackGraph-arm64" "$work/FeedbackGraph-x86_64" -output "$app/Contents/MacOS/FeedbackGraph"

xcrun swiftc -module-cache-path "$out/swift-cache" "$root/macos/make-icon.swift" -o "$work/make-icon"
"$work/make-icon" "$root/macos/AppIcon.svg" "$work/AppIcon.iconset"
iconutil -c icns "$work/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
cp "$root/LICENSE" "$root/NOTICE" "$app/Contents/Resources/"

cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.chaosdeselva.feedbackgraph</string>
<key>CFBundleName</key><string>Feedback Graph</string>
<key>CFBundleDisplayName</key><string>Feedback Graph</string>
<key>CFBundleExecutable</key><string>FeedbackGraph</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Apache License 2.0</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
rm -rf "$work"

if [ -n "${FG_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$FG_SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app"
  echo "Ad hoc signed: for this Mac. Set FG_SIGN_IDENTITY to a Developer ID Application identity for a build to share."
fi
codesign --verify --strict "$app"
echo "$app"
