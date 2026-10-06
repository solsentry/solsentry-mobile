// Single place for cluster + API configuration.
export type Cluster = 'mainnet-beta' | 'devnet'

export const CLUSTER: Cluster = 'mainnet-beta'

export const RPC_URL = 'https://api.mainnet-beta.solana.com'
export const API_BASE = 'https://api.solsentry.app'

/** .skr names live on mainnet whatever CLUSTER is. */
export const NAME_RPC_URL = 'https://api.mainnet-beta.solana.com'
/** Seeker Genesis Tokens exist on mainnet only, whatever CLUSTER is. */
export const SGT_RPC_URL = 'https://api.mainnet-beta.solana.com'
/** Official SNS REST proxy (v2); the v1 host sdk-proxy.sns.id is scheduled for retirement. */
export const SNS_PROXY_URL = 'https://sdk-proxy-v2.sns.id'

/** MWA chain identifier derived from CLUSTER. */
export const MWA_CHAIN = CLUSTER === 'mainnet-beta' ? 'solana:mainnet' : 'solana:devnet'

export const APP_IDENTITY = {
  name: 'SolSentry Guard',
  uri: 'https://solsentry.app',
  icon: 'favicon.png',
} as const

/** "Claim Seeker access" (SIWS sign-in + /v1/seeker/claim). Off until the server side ships. */
export const SEEKER_CLAIM_ENABLED = false

/** A verdict older than this must be re-run before sending. */
export const VERDICT_MAX_AGE_MS = 5 * 60 * 1000

export function solscanTx(signature: string): string {
  const suffix = CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`
  return `https://solscan.io/tx/${signature}${suffix}`
}
