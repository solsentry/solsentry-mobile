// Expo config plugin: sign release builds with a keystore that lives OUTSIDE the repo.
// Reads KEYSTORE_PROPERTIES (env) or ~/.keys/solsentry-kyw/keystore.properties.

const fs = require('fs')
const path = require('path')
const { withAppBuildGradle, withGradleProperties, withDangerousMod, withAndroidManifest } = require('@expo/config-plugins')

const MARK = '// solsentry-release-signing'

const SIGNING_LOADER = `
${MARK}
def ksPropsPath = System.getenv('KEYSTORE_PROPERTIES') ?: "\${System.getProperty('user.home')}/.keys/solsentry-kyw/keystore.properties"
def ksProps = new Properties()
def ksFile = new File(ksPropsPath)
if (ksFile.exists()) { ksFile.withInputStream { ksProps.load(it) } }
// Checked when the task graph is known, so a clone without the keystore still builds debug.
gradle.taskGraph.whenReady { graph ->
    def wantsRelease = graph.allTasks.any { it.project == project && it.name.endsWith('Release') }
    if (wantsRelease && !ksFile.exists()) {
        throw new GradleException("Release keystore properties not found at " + ksPropsPath)
    }
}
`

function patchGradle(src) {
  if (src.includes(MARK)) return src
  src = src.replace(/\nandroid \{/, `${SIGNING_LOADER}\nandroid {`)
  src = src.replace(
    /signingConfigs \{\n(\s*)debug \{/,
    `signingConfigs {\n$1release {\n$1    if (ksFile.exists()) {\n$1        storeFile file(ksProps['storeFile'])\n$1        storePassword ksProps['storePassword']\n$1        keyAlias ksProps['keyAlias']\n$1        keyPassword ksProps['keyPassword']\n$1    }\n$1}\n$1debug {`,
  )
  src = src.replace(
    /(release \{\n\s*\/\/ Caution![^\n]*\n\s*\/\/ see [^\n]*\n\s*)signingConfig signingConfigs\.debug/,
    `$1signingConfig signingConfigs.release`,
  )
  // A silent miss would leave the release build signed with the debug key.
  if (!src.includes('signingConfig signingConfigs.release') || !src.includes("ksProps['storeFile']") || !src.includes(MARK)) {
    throw new Error('with-release-signing: build.gradle patch did not apply (template changed?)')
  }
  return src
}

module.exports = (config) => {
  config = withAppBuildGradle(config, (c) => {
    c.modResults.contents = patchGradle(c.modResults.contents)
    return c
  })
  // Phone (arm64) + x86_64 emulators only; keeps the APK and build time smaller.
  config = withGradleProperties(config, (c) => {
    const item = c.modResults.find((p) => p.type === 'property' && p.key === 'reactNativeArchitectures')
    if (item) item.value = 'arm64-v8a,x86_64'
    return c
  })
  // RN 0.83.x's included gradle-plugin build pins foojay-resolver 0.5.0, which crashes on Gradle 9
  // (JvmVendorSpec.IBM_SEMERU). Use the last Gradle 8 release until RN bumps it.
  config = withDangerousMod(config, [
    'android',
    (c) => {
      const f = path.join(c.modRequest.platformProjectRoot, 'gradle/wrapper/gradle-wrapper.properties')
      const txt = fs.readFileSync(f, 'utf8').replace(/gradle-9\.[\d.]+-bin\.zip/, 'gradle-8.14.3-bin.zip')
      fs.writeFileSync(f, txt)
      return c
    },
  ])
  // Self-test builds talk to a server on the PC through `adb reverse`, which is plain HTTP.
  if (process.env.EXPO_PUBLIC_KYW_SELFTEST === '1') {
    config = withAndroidManifest(config, (c) => {
      c.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true'
      return c
    })
  }
  return config
}
