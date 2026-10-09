// Flags of a self-test build (EXPO_PUBLIC_KYW_SELFTEST=1 when bundling, see metro.config.js).
// The API base is a server on the PC reached with `adb reverse tcp:8092 tcp:8092`.
export const SELFTEST_BUILD: boolean = true
export const API_BASE_OVERRIDE: string | null = 'http://127.0.0.1:8092'
