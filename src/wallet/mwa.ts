import { Connection } from '@solana/web3.js'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { RPC_URL, VERDICT_MAX_AGE_MS } from '../config'
import type { PayExtras } from '../pay/transfer'
import { sendTracked, type PendingSend } from './send-recovery'
import { disconnectWallet, withAuthorizedWallet, type AuthCallbacks, type WalletSession } from './mwa-session'

export { parseSolToLamports } from './mwa-math'
export type { WalletSession } from './mwa-session'

/**
 * Open the wallet app and authorize this app. No signing happens here. A stale `authToken`
 * falls back to a fresh authorization prompt.
 */
export async function connectWallet(authToken?: string, cb?: AuthCallbacks): Promise<WalletSession> {
  return await withAuthorizedWallet(transact, authToken, async (_wallet, session) => session, cb)
}

/** Clear local state now, then ask the wallet to revoke the token (best effort, never throws). */
export async function disconnect(session: WalletSession | null, clearLocal: () => void): Promise<boolean> {
  return await disconnectWallet(transact, session, clearLocal)
}

export interface SendResult {
  signature: string
  from: string
}

/**
 * Authorize, build one SystemProgram.transfer from the authorized account, and ask the
 * wallet to sign and send it. The app never sees a private key. `extras` carries the
 * Solana Pay reference keys and memo when the payment came from a scanned request.
 * `cb.onSession` fires as soon as the wallet authorizes, so a fresh token is kept even if
 * the user then cancels the signature. A non-decline failure after the request reached the
 * wallet throws SendOutcomeUnknownError (see send-recovery.ts): the caller must check the chain.
 *
 * The MWA response timeout cannot be raised from JS: it is CLIENT_TIMEOUT_MS = 90000, a private
 * constant in the library's Android module (SolanaMobileWalletAdapterModule.kt), and transact()
 * only accepts { baseUri }.
 */
export async function sendSol(
  recipient: string,
  lamports: bigint,
  checkedAt: number,
  authToken?: string,
  extras?: PayExtras,
  cb?: AuthCallbacks,
  onPending?: (p: PendingSend) => void,
): Promise<SendResult & { session: WalletSession }> {
  const connection = new Connection(RPC_URL, 'confirmed')
  return sendTracked(
    {
      transact,
      getLatestBlockhash: () => connection.getLatestBlockhash(),
      getSlot: () => connection.getSlot('confirmed'),
      maxVerdictAgeMs: VERDICT_MAX_AGE_MS,
    },
    { recipient, lamports, checkedAt, authToken, extras, cb, onPending },
  )
}
