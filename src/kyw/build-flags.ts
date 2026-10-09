// Flags of a normal build. A self-test build swaps this file for build-flags.selftest.ts in
// metro.config.js. Nothing here reads the environment: an inlined environment value can survive
// in the bundler's transform cache and leak into a later build.
export const SELFTEST_BUILD: boolean = false
export const API_BASE_OVERRIDE: string | null = null
