import { Redirect } from 'expo-router'
import React from 'react'

import { SELFTEST_BUILD } from '@/src/kyw/config'

// A require, not an import: in a normal build metro.config.js resolves this module to an empty
// one, so the screen and the vectors it carries are not in the bundle.
const SelfTestScreen: React.ComponentType | null = SELFTEST_BUILD
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@/src/kyw/selftest/SelfTestScreen').default ?? null)
  : null

export default function SelfTestRoute() {
  return SelfTestScreen ? <SelfTestScreen /> : <Redirect href="/" />
}
