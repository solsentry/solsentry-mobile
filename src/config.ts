// Single place for cluster + API configuration.
export type Cluster = 'mainnet-beta' | 'devnet'

export const CLUSTER: Cluster = 'mainnet-beta'

export const RPC_URL = 'https://api.mainnet-beta.solana.com'
export const API_BASE = 'https://api.solsentry.app'

/** Seeker Genesis Tokens exist on mainnet only, whatever CLUSTER is. */
export const SGT_RPC_URL = 'https://api.mainnet-beta.solana.com'
/** Official SNS REST proxy (v2); the v1 host sdk-proxy.sns.id is scheduled for retirement. */
export const SNS_PROXY_URL = 'https://sdk-proxy-v2.sns.id'

/** MWA chain identifier derived from CLUSTER. */
export const MWA_CHAIN = CLUSTER === 'mainnet-beta' ? 'solana:mainnet' : 'solana:devnet'

export const APP_IDENTITY = {
  name: 'SolSentry',
  uri: 'https://solsentry.app',
  icon: 'favicon-192.png',
} as const

export function solscanTx(signature: string): string {
  const suffix = CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`
  return `https://solscan.io/tx/${signature}${suffix}`
}

/**
 * Android hardware key attestation of this phone's signing key. With false the native module is
 * never called and the phone signs with a random id (no attested class on SolSentry).
 */
export const DEVICE_CHECK_ENABLED: boolean = true

/**
 * How SKR reaches the linked wallet. 'claim': the Claim button builds the transaction the wallet
 * signs and sends. 'later': no Claim; the balance accrues and is paid out from the ledger later.
 */
export const SKR_PAYOUT: 'claim' | 'later' = 'claim'
