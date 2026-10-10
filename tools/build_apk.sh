#!/usr/bin/env bash
# Build one APK variant and prove which variant came out.
#   tools/build_apk.sh release  <out.apk>   normal build, production API
#   tools/build_apk.sh selftest <out.apk>   adds the vector self-test and a local API base
#
# Why a script: Gradle does not see the variant (it is an environment variable read by
# metro.config.js), so it reuses the previous JavaScript bundle when the sources did not change.
# The bundle task is always re-run here, and the result is checked before the APK is copied.
set -euo pipefail
variant="${1:?release or selftest}"
out="$(realpath -m "${2:?output apk path}")"
cd "$(dirname "$0")/.."
: "${JAVA_HOME:?set JAVA_HOME}" "${ANDROID_HOME:?set ANDROID_HOME}"
export NODE_ENV=production CI=1
unset EXPO_PUBLIC_KYW_SELFTEST
case "$variant" in
  release) npx expo prebuild -p android --clean --no-install ;;
  selftest) export EXPO_PUBLIC_KYW_SELFTEST=1; npx expo prebuild -p android --clean --no-install ;;
  *) echo "unknown variant: $variant" >&2; exit 2 ;;
esac
cd android
./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks --max-workers=2 --no-daemon
./gradlew assembleRelease --max-workers=2 --no-daemon
apk=app/build/outputs/apk/release/app-release.apk
marks=$(unzip -p "$apk" assets/index.android.bundle | strings -n 4 | grep -c -E 'KYW_SELFTEST|127\.0\.0\.1:80' || true)
cleartext=$(grep -c 'usesCleartextTraffic="true"' app/src/main/AndroidManifest.xml || true)
if [ "$variant" = release ] && { [ "$marks" != 0 ] || [ "$cleartext" != 0 ]; }; then
  echo "REFUSED: release build carries self-test content (marks=$marks cleartext=$cleartext)" >&2; exit 1
fi
if [ "$variant" = selftest ] && [ "$marks" = 0 ]; then
  echo "REFUSED: self-test build has no self-test content" >&2; exit 1
fi
cp "$apk" "$out"
echo "VARIANT_OK $variant marks=$marks cleartext=$cleartext"
sha256sum "$out"
