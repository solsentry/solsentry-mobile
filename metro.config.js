// Build variants are chosen here, at resolution time, and never by reading the environment inside
// app code. A normal build gets an empty module in place of the self-test screen, so neither the
// screen nor the vectors it carries reach the bundle.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const selftest = process.env.EXPO_PUBLIC_KYW_SELFTEST === '1'

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (!selftest && /selftest\/SelfTestScreen$/.test(moduleName)) return { type: 'empty' }
  if (selftest && /(^|\/)build-flags$/.test(moduleName)) {
    return context.resolveRequest(context, `${moduleName}.selftest`, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
