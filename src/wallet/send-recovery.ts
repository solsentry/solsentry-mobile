// What happens when the wallet does not answer signAndSendTransactions in time.
//
// Measured on a Seeker: the user sat on the Seed Vault prompt, the MWA client gave up after its
// fixed 90 s response timeout ("TimeoutException: Timed out waiting for response with id=2"), and
// the wallet still signed and submitted. Reporting that as a failure invites a second, paid send.
// So once the request has reached the wallet, any error that is not a user decline means
// "outcome unknown": the app looks the transfer up on chain before saying anything.
//
// No React Native imports here, so the whole flow runs under vitest with a fake RPC and wallet.
import { PublicKey, Transaction } from '@solana/web3.js'
import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { RPC_TIMEOUT_MS, fetchWithTimeout } from '../guard/fetch-timeout'
import { buildSolTransferInstructions, type PayExtras } from '../pay/transfer'
import { describeError } from '../ui/errors'
import { assertVerdictFresh } from './mwa-math'
import { isSessionGone, withAuthorizedWallet, type AuthCallbacks, type Transact, type WalletSession } from './mwa-session'

/** Everything needed to find the transfer on chain later; recorded right before the wallet is asked. */
export interface PendingSend {
  sender: string
  recipient: string
  lamports: bigint
  blockhash: string
  lastValidBlockHeight: number
  /** Device clock (ms) when the request went to the wallet. */
  startedAt: number
}

export const CHECKING_NETWORK = 'Wallet did not confirm in time — checking the network…'
export const NOT_SENT = 'Not sent (the network did not receive it). You can try again.'
export const COULD_NOT_CONFIRM = "Could not confirm yet — check your wallet's history before trying again."

/** The request reached the wallet and then failed in a way that does not say whether it was sent. */
export class SendOutcomeUnknownError extends Error {
  constructor(
    readonly pending: PendingSend,
    readonly cause: unknown,
  ) {
    super(CHECKING_NETWORK)
    this.name = 'SendOutcomeUnknownError'
  }
}

/**
 * The user said no in the wallet. A dropped session is NOT a decline here even though
 * describeError words it as one: after the request was sent, the wallet may have submitted anyway.
 */
export function isWalletDecline(e: unknown): boolean {
  return !!describeError(e, 'send').cancelled && !isSessionGone(e)
}

export interface SendDeps {
  transact: Transact
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>
  maxVerdictAgeMs: number
  now?: () => number
}

export interface SendRequest {
  recipient: string
  lamports: bigint
  checkedAt: number
  authToken?: string
  extras?: PayExtras
  cb?: AuthCallbacks
}

/**
 * Authorize, build one transfer, and ask the wallet to sign and send it. A failure after the
 * request reached the wallet (and that is not a decline) becomes SendOutcomeUnknownError.
 */
export async function sendTracked(
  deps: SendDeps,
  req: SendRequest,
): Promise<{ signature: string; from: string; session: WalletSession }> {
  const now = deps.now ?? Date.now
  const to = new PublicKey(req.recipient)
  // Set inside the transact callback; read in the catch below, so an object, not a let.
  const st: { pending: PendingSend | null } = { pending: null }
  try {
    return await withAuthorizedWallet(
      deps.transact,
      req.authToken,
      async (wallet: Web3MobileWallet, session) => {
        // The user may sit on the wallet prompt for minutes: re-check the verdict age right before building.
        assertVerdictFresh(req.checkedAt, deps.maxVerdictAgeMs, now())
        const from = new PublicKey(session.address)
        const { blockhash, lastValidBlockHeight } = await deps.getLatestBlockhash()
        const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
          ...buildSolTransferInstructions(from, to, req.lamports, req.extras),
        )
        st.pending = {
          sender: session.address,
          recipient: req.recipient,
          lamports: req.lamports,
          blockhash,
          lastValidBlockHeight,
          startedAt: now(),
        }
        const [signature] = await wallet.signAndSendTransactions({ transactions: [tx] })
        if (!signature) throw new Error('The wallet returned no signature.')
        return { signature, from: session.address, session }
      },
      req.cb,
    )
  } catch (e) {
    if (st.pending && !isWalletDecline(e)) throw new SendOutcomeUnknownError(st.pending, e)
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// On-chain lookup

export type RecoveryResult =
  | { status: 'found'; signature: string }
  | { status: 'expired' }
  | { status: 'unknown' }

/** One JSON-RPC call; returns the parsed envelope ({ result } or { error }). Throws on transport failure. */
export type RpcCall = (method: string, params: unknown[], timeoutMs: number) => Promise<any>

export interface RecoveryDeps {
  rpc: RpcCall
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const RECOVERY_CAP_MS = 90_000
/** Minimum gap between two requests to the public RPC. */
export const RECOVERY_INTERVAL_MS = 2_000
const SIGNATURE_LIMIT = 10
/** Device clock vs block time: a candidate this much older than startedAt is still looked at. */
const CLOCK_SKEW_S = 120

/** Plain fetch-based RPC (one call per request, no batch), body bounded by fetchWithTimeout. */
export function publicRpc(url: string, base: typeof fetch = (u, i) => globalThis.fetch(u, i)): RpcCall {
  return async (method, params, timeoutMs) => {
    const res = await fetchWithTimeout(base, timeoutMs, 'Network check')(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok && res.status !== 429) throw new Error(`RPC HTTP ${res.status}`)
    return await res.json()
  }
}

interface ParsedIx {
  program?: string
  programId?: string
  parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number | string } }
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/**
 * Does this getTransaction(jsonParsed) result hold a successful SystemProgram transfer of exactly
 * `lamports` from sender to recipient? Other instructions (ComputeBudget, Lighthouse, memo) are ignored.
 */
export function hasMatchingTransfer(tx: any, p: Pick<PendingSend, 'sender' | 'recipient' | 'lamports'>): boolean {
  if (!tx || tx.meta?.err != null) return false
  const ixs: ParsedIx[] = tx.transaction?.message?.instructions ?? []
  return ixs.some((ix) => {
    if (ix.program !== 'system' && ix.programId !== SYSTEM_PROGRAM) return false
    if (ix.parsed?.type !== 'transfer') return false
    const info = ix.parsed.info
    if (!info || info.source !== p.sender || info.destination !== p.recipient || info.lamports == null) return false
    try {
      return BigInt(info.lamports) === p.lamports
    } catch {
      return false
    }
  })
}

/**
 * Look for the pending transfer on chain. Stops on: found; blockhash expired with nothing found
 * (it can never land now); or the time cap (outcome still unknown). One request at a time, at most
 * one every RECOVERY_INTERVAL_MS. RPC errors are not conclusions: they only cost time.
 */
export async function recoverPendingSend(
  p: PendingSend,
  deps: RecoveryDeps,
  capMs: number = RECOVERY_CAP_MS,
  intervalMs: number = RECOVERY_INTERVAL_MS,
): Promise<RecoveryResult> {
  const t0 = deps.now()
  const deadline = t0 + capMs
  let lastCall = -Infinity
  const startedS = Math.floor(p.startedAt / 1000)
  /** Signatures already read and ruled out. */
  const ruledOut = new Set<string>()

  /** Paced, deadline-bounded call. null = out of time; { error } envelope or a throw = failed call. */
  async function call(method: string, params: unknown[]): Promise<{ ok: true; result: any } | { ok: false } | null> {
    const wait = lastCall + intervalMs - deps.now()
    if (wait > 0) await deps.sleep(wait)
    const left = deadline - deps.now()
    if (left <= 0) return null
    lastCall = deps.now()
    try {
      const r = await deps.rpc(method, params, Math.min(RPC_TIMEOUT_MS, left))
      if (r && !r.error && 'result' in r) return { ok: true, result: r.result }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }

  for (;;) {
    // Height first, scan second: if the blockhash was already expired before a complete scan that
    // found nothing, the transfer cannot have landed (nor land later).
    const h = await call('getBlockHeight', [{ commitment: 'finalized' }])
    if (h === null) return { status: 'unknown' }
    const expired = h.ok && typeof h.result === 'number' && h.result > p.lastValidBlockHeight

    const sigs = await call('getSignaturesForAddress', [p.sender, { limit: SIGNATURE_LIMIT, commitment: 'confirmed' }])
    if (sigs === null) return { status: 'unknown' }
    const rows: { signature: string; err: unknown; blockTime?: number | null }[] =
      sigs.ok && Array.isArray(sigs.result) ? sigs.result : []
    let complete = sigs.ok && Array.isArray(sigs.result)
    // All 10 newer than the window start: older ones may be hidden, so a miss proves nothing.
    const oldest = rows[rows.length - 1]
    if (rows.length >= SIGNATURE_LIMIT && oldest?.blockTime != null && oldest.blockTime >= startedS - CLOCK_SKEW_S) {
      complete = false
    }
    for (const s of rows) {
      if (ruledOut.has(s.signature) || s.err != null) continue
      if (s.blockTime != null && s.blockTime < startedS - CLOCK_SKEW_S) continue
      const t = await call('getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
      ])
      if (t === null) return { status: 'unknown' }
      if (!t.ok || !t.result) {
        complete = false
        continue
      }
      // Same blockhash = built from our request; otherwise it must be no older than the request.
      const ours =
        t.result.transaction?.message?.recentBlockhash === p.blockhash ||
        (typeof t.result.blockTime === 'number' && t.result.blockTime >= startedS)
      if (ours && hasMatchingTransfer(t.result, p)) return { status: 'found', signature: s.signature }
      ruledOut.add(s.signature)
    }
    if (expired && complete) return { status: 'expired' }
  }
}

// ---------------------------------------------------------------------------------------------
// Send-button guard

export interface PendingGuard {
  recipient: string
  lamports: bigint
  phase: 'checking' | 'unconfirmed'
}

/** While a check runs nothing may be sent; after "could not confirm", only the same recipient+amount is held. */
export function blockedByPending(g: PendingGuard | null, recipient: string, lamports: bigint | null): boolean {
  if (!g) return false
  if (g.phase === 'checking') return true
  return recipient === g.recipient && lamports === g.lamports
}

/** Guard after the user edits recipient or amount: an ended check is released; a running one is kept. */
export function guardAfterEdit(g: PendingGuard | null): PendingGuard | null {
  return g?.phase === 'checking' ? g : null
}
