import { API_BASE } from '../config'

/**
 * Self-test builds only (EXPO_PUBLIC_KYW_SELFTEST=1 at bundle time): the vectors screen is bundled
 * and the API base can point at a local server. A normal release ignores both variables.
 */
export const SELFTEST_BUILD: boolean = process.env.EXPO_PUBLIC_KYW_SELFTEST === '1'

export const KYW_API_BASE: string =
  process.env.EXPO_PUBLIC_KYW_SELFTEST === '1' && process.env.EXPO_PUBLIC_KYW_API_BASE
    ? process.env.EXPO_PUBLIC_KYW_API_BASE
    : API_BASE
