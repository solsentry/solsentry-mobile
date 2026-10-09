import { Redirect } from 'expo-router'
import React from 'react'

// A conditional require (not an import): in a normal release the bundler folds the condition to
// false and drops the screen together with the vectors it carries.
const SelfTestScreen: React.ComponentType | null =
  process.env.EXPO_PUBLIC_KYW_SELFTEST === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/src/kyw/selftest/SelfTestScreen').default
    : null

export default function SelfTestRoute() {
  return SelfTestScreen ? <SelfTestScreen /> : <Redirect href="/" />
}
