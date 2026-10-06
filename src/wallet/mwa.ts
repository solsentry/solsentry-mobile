import { PublicKey, Transaction, Connection } from '@solana/web3.js'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { RPC_URL, VERDICT_MAX_AGE_MS } from '../config'
import { buildSolTransferInstructions, type PayExtras } from '../pay/transfer'
import { assertVerdictFresh } from './mwa-math'
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
 * the user then cancels the signature.
 */
export async function sendSol(
  recipient: string,
  lamports: bigint,
  checkedAt: number,
  authToken?: string,
  extras?: PayExtras,
  cb?: AuthCallbacks,
): Promise<SendResult & { session: WalletSession }> {
  const to = new PublicKey(recipient)
  const connection = new Connection(RPC_URL, 'confirmed')
  return withAuthorizedWallet(
    transact,
    authToken,
    async (wallet, session) => {
      // The user may sit on the wallet prompt for minutes: re-check the verdict age right before building.
      assertVerdictFresh(checkedAt, VERDICT_MAX_AGE_MS)
      const from = new PublicKey(session.address)
      const { blockhash } = await connection.getLatestBlockhash()
      const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
        ...buildSolTransferInstructions(from, to, lamports, extras),
      )
      const [signature] = await wallet.signAndSendTransactions({ transactions: [tx] })
      if (!signature) throw new Error('The wallet returned no signature.')
      return { signature, from: session.address, session }
    },
    cb,
  )
}
