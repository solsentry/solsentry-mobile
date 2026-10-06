// Expo config plugin: sign release builds with a keystore that lives OUTSIDE the repo.
// Reads KEYSTORE_PROPERTIES (env) or ~/.keys/solsentry-guard-mobile/keystore.properties.

const fs = require('fs')
const path = require('path')
const { withAppBuildGradle, withGradleProperties, withDangerousMod } = require('@expo/config-plugins')

const MARK = '// solsentry-release-signing'

const SIGNING_LOADER = `
${MARK}
def ksPropsPath = System.getenv('KEYSTORE_PROPERTIES') ?: "\${System.getProperty('user.home')}/.keys/solsentry-guard-mobile/keystore.properties"
def ksProps = new Properties()
def ksFile = new File(ksPropsPath)
if (ksFile.exists()) { ksFile.withInputStream { ksProps.load(it) } }
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
    `$1if (!ksFile.exists()) { throw new GradleException("Release keystore properties not found at " + ksPropsPath) }\n            signingConfig signingConfigs.release`,
  )
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
  return config
}
