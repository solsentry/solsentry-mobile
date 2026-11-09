import { Redirect } from 'expo-router'
import React from 'react'
import { SELFTEST_BUILD } from '@/src/kyw/config'

const CertificateScreen: React.ComponentType | null = SELFTEST_BUILD
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@/src/alpenglow/selftest/CertificateScreen').default ?? null)
  : null

export default function CertificateRoute() {
  return CertificateScreen ? <CertificateScreen /> : <Redirect href="/" />
}
