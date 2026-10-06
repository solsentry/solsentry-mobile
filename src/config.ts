// Single place for cluster + API configuration.
export type Cluster = 'mainnet-beta' | 'devnet'

export const CLUSTER: Cluster = 'mainnet-beta'

export const RPC_URL = 'https://api.mainnet-beta.solana.com'
export const API_BASE = 'https://api.solsentry.app'

/** MWA chain identifier derived from CLUSTER. */
export const MWA_CHAIN = CLUSTER === 'mainnet-beta' ? 'solana:mainnet' : 'solana:devnet'

export const APP_IDENTITY = {
  name: 'SolSentry Guard',
  uri: 'https://solsentry.app',
  icon: 'favicon.png',
} as const

/** A verdict older than this must be re-run before sending. */
export const VERDICT_MAX_AGE_MS = 5 * 60 * 1000

export function solscanTx(signature: string): string {
  const suffix = CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`
  return `https://solscan.io/tx/${signature}${suffix}`
}
