#!/usr/bin/env bash
# Notarizes and staples a Developer ID build of the Mac app (FG_SIGN_IDENTITY=... ./scripts/build-mac-app.sh), using a
# notarytool profile you stored with: xcrun notarytool store-credentials <profile>
#   ./scripts/notarize-mac-app.sh "dist/Feedback Graph.app" <profile>
# Then ./scripts/build-dmg.sh packs the stapled app; notarize the .dmg too if you publish it:
#   ./scripts/notarize-mac-app.sh dist/Feedback-Graph-<version>.dmg <profile>
set -euo pipefail
target="${1:?the signed app or dmg}"
profile="${2:?the notarytool keychain profile name}"
# Only a Developer ID signature can be notarized: check before uploading anything.
codesign -dv --verbose=2 "$target" 2>&1 | grep -q 'Authority=Developer ID Application:' ||
  { echo "$target is not signed with a Developer ID Application identity (set FG_SIGN_IDENTITY when building)" >&2; exit 1; }
case "$target" in
  *.app)
    archive="${target%.app}-notarization.zip"
    ditto -c -k --keepParent "$target" "$archive"
    xcrun notarytool submit "$archive" --keychain-profile "$profile" --wait
    rm -f "$archive"
    xcrun stapler staple "$target"
    spctl --assess --type execute --verbose "$target" ;;
  *.dmg)
    xcrun notarytool submit "$target" --keychain-profile "$profile" --wait
    xcrun stapler staple "$target"
    spctl --assess --type open --context context:primary-signature --verbose "$target" ;;
  *) echo "expected a .app or a .dmg" >&2; exit 1 ;;
esac
xcrun stapler validate "$target"
