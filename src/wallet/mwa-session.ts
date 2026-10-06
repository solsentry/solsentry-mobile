// MWA authorization logic without the React Native module, so it can be unit tested with a fake
// `transact` and a fake wallet. src/wallet/mwa.ts wires in the real `transact`.
import { PublicKey } from '@solana/web3.js'
import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { APP_IDENTITY, MWA_CHAIN } from '../config'

export interface WalletSession {
  address: string
  authToken: string
  label?: string
}

/** Same shape as the library's transact (it resolves a returned promise, so R may be a Promise). */
export type Transact = <R>(callback: (wallet: Web3MobileWallet) => R) => Promise<R>

export interface AuthCallbacks {
  /** A (re)authorization succeeded: store this session, even if the rest of the flow fails later. */
  onSession?: (s: WalletSession) => void
  /** The wallet rejected the stored token and no fresh authorization replaced it: drop the token. */
  onTokenRejected?: () => void
}

function decodeAddress(b64: string): PublicKey {
  const bin = globalThis.atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new PublicKey(bytes)
}

/**
 * MWA ERROR_AUTHORIZATION_FAILED (-1). Inside a transact callback the React Native module rejects
 * with code "JSON_RPC_ERROR" and the MWA code in userInfo; outside it, the library has already
 * wrapped it into SolanaMobileWalletAdapterProtocolError with code -1. Both shapes count.
 */
export function isAuthorizationFailed(e: unknown): boolean {
  const x = e as { code?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } | null } | null
  if (!x || typeof x !== 'object') return false
  return x.code === -1 || (x.code === 'JSON_RPC_ERROR' && x.userInfo?.jsonRpcErrorCode === -1)
}

/** The wallet session itself is gone (not a user decision): a new transact may succeed. */
export function isSessionGone(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown } | null
  if (!x || typeof x !== 'object') return false
  if (
    x.code === 'ERROR_SESSION_CLOSED' ||
    x.code === 'ERROR_SESSION_TIMEOUT' ||
    x.code === 'ERROR_ILLEGAL_TRANSPORT_STATE'
  ) {
    return true
  }
  return typeof x.message === 'string' && /without an active session/i.test(x.message)
}

/** One authorize call. No token (or an empty one) = a fresh authorization prompt in the wallet. */
export async function authorizeIn(
  wallet: Pick<Web3MobileWallet, 'authorize'>,
  authToken?: string,
): Promise<WalletSession> {
  const auth = await wallet.authorize({
    chain: MWA_CHAIN,
    identity: APP_IDENTITY,
    auth_token: authToken || undefined,
  })
  const account = auth.accounts[0]
  if (!account) throw new Error('The wallet returned no account.')
  return {
    address: decodeAddress(account.address).toBase58(),
    authToken: auth.auth_token,
    label: account.label,
  }
}

/**
 * Authorize, then run `work` in the same wallet session.
 *
 * A stored token goes stale when the user cancels or revokes on the wallet side; the wallet then
 * answers -1 ("authorization request failed") to every request that carries it. When that happens
 * the token is dropped and a fresh authorize (no token) is asked in the SAME session. If that
 * session is already closed, one more transact is opened for the fresh authorize. A user decline
 * of the fresh prompt is final: it is not retried.
 */
export async function withAuthorizedWallet<T>(
  transact: Transact,
  authToken: string | undefined,
  work: (wallet: Web3MobileWallet, session: WalletSession) => Promise<T>,
  cb: AuthCallbacks = {},
): Promise<T> {
  // An object, not two lets: they change inside the transact callback.
  const st: { phase: 'auth' | 'fresh' | 'work'; rejected: boolean } = { phase: 'auth', rejected: false }
  const inWork = () => st.phase === 'work'
  const run = (token: string | undefined) =>
    transact(async (wallet) => {
      let session: WalletSession
      if (token) {
        try {
          session = await authorizeIn(wallet, token)
        } catch (e) {
          if (!isAuthorizationFailed(e)) throw e
          st.rejected = true
          st.phase = 'fresh'
          session = await authorizeIn(wallet)
        }
      } else {
        session = await authorizeIn(wallet)
      }
      st.phase = 'work'
      cb.onSession?.(session)
      return await work(wallet, session)
    })
  try {
    return await run(authToken)
  } catch (e) {
    if (st.phase === 'fresh' && isSessionGone(e)) {
      try {
        st.phase = 'auth'
        return await run(undefined)
      } catch (e2) {
        if (!inWork()) cb.onTokenRejected?.()
        throw e2
      }
    }
    if (st.rejected && !inWork()) cb.onTokenRejected?.()
    throw e
  }
}
