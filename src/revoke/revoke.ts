// One revoke, end to end, without the React Native module (fake `transact` under vitest).
// "Revoked" is only ever reported after the token account was read again and has no delegate:
// a signature alone is not a confirmation.
import { PublicKey, Transaction } from '@solana/web3.js'
import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { isWalletDecline } from '../wallet/send-recovery'
import { withAuthorizedWallet, type AuthCallbacks, type Transact, type WalletSession } from '../wallet/mwa-session'
import type { Delegation } from './delegations'
import { buildRevokeInstruction } from './instruction'

export type RevokeResult =
  /** Read again from chain: the account has no delegate. `signature` is absent if the wallet never answered. */
  | { status: 'revoked'; signature?: string }
  /** The user declined in the wallet. */
  | { status: 'cancelled' }
  /** The request reached the wallet but the account still shows the delegate, or could not be read. */
  | { status: 'unconfirmed'; signature?: string; detail?: string }

export interface RevokeDeps {
  transact: Transact
  getLatestBlockhash: () => Promise<{ blockhash: string }>
  /** Re-read of the token account; throws when the read fails. */
  hasActiveDelegate: (account: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

export const WRONG_WALLET = 'The wallet authorized a different account. Nothing was signed.'
export const CONFIRM_ATTEMPTS = 10
export const CONFIRM_INTERVAL_MS = 2_000

async function confirmGone(deps: RevokeDeps, account: string): Promise<{ gone: boolean; detail?: string }> {
  let detail: string | undefined
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    if (i > 0) await deps.sleep(CONFIRM_INTERVAL_MS)
    try {
      if (!(await deps.hasActiveDelegate(account))) return { gone: true }
      detail = undefined
    } catch (e) {
      detail = (e as Error)?.message ?? String(e)
    }
  }
  return { gone: false, detail }
}

/**
 * Authorize, build ONE Revoke for `d` with the connected wallet as owner and fee payer, ask the
 * wallet to sign and send it, then read the account again. Errors before the wallet was asked to
 * sign are thrown (nothing happened). After that point only a decline is "cancelled"; anything
 * else is settled by the re-read, because the wallet may have submitted anyway.
 */
export async function revokeDelegation(
  deps: RevokeDeps,
  d: Delegation,
  owner: string,
  authToken?: string,
  cb?: AuthCallbacks,
): Promise<RevokeResult & { session?: WalletSession }> {
  const st: { asked: boolean; session?: WalletSession } = { asked: false }
  let signature: string | undefined
  try {
    signature = await withAuthorizedWallet(
      deps.transact,
      authToken,
      async (wallet: Web3MobileWallet, session) => {
        st.session = session
        // The wallet may hand back another account than the one whose approvals are listed.
        if (session.address !== owner) throw new Error(WRONG_WALLET)
        const ownerKey = new PublicKey(owner)
        const { blockhash } = await deps.getLatestBlockhash()
        const tx = new Transaction({ feePayer: ownerKey, recentBlockhash: blockhash }).add(
          buildRevokeInstruction(new PublicKey(d.account), ownerKey, new PublicKey(d.programId)),
        )
        st.asked = true
        const [sig] = await wallet.signAndSendTransactions({ transactions: [tx] })
        return sig || undefined
      },
      cb,
    )
  } catch (e) {
    if (!st.asked) throw e
    if (isWalletDecline(e)) return { status: 'cancelled', session: st.session }
  }
  const { gone, detail } = await confirmGone(deps, d.account)
  return gone
    ? { status: 'revoked', signature, session: st.session }
    : { status: 'unconfirmed', signature, detail, session: st.session }
}
