// Token approvals (SPL "delegates") of one wallet, read from chain only.
// No React Native imports here, so parsing and the RPC failure paths run under vitest.
import { RPC_TIMEOUT_MS, fetchWithTimeout } from '../guard/fetch-timeout'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]

const U64_MAX = 18_446_744_073_709_551_615n

export type DelegationKind = 'UNLIMITED' | 'FULL_BALANCE' | 'AMOUNT'

export interface Delegation {
  /** Token account address. */
  account: string
  mint: string
  /** Program that owns the token account (Token or Token-2022): the Revoke goes to this one. */
  programId: string
  delegate: string
  delegatedRaw: bigint
  /** Delegated amount in token units, as the RPC formats it. */
  delegatedUi: string
  kind: DelegationKind
  /** The token program refuses Revoke on a frozen account. */
  frozen: boolean
}

interface ParsedTokenAccount {
  pubkey?: unknown
  account?: {
    owner?: unknown
    data?: { parsed?: { type?: unknown; info?: Record<string, unknown> } }
  }
}

function rawAmount(v: unknown): bigint | null {
  const a = (v as { amount?: unknown } | null | undefined)?.amount
  return typeof a === 'string' && /^\d+$/.test(a) ? BigInt(a) : null
}

/**
 * Rows for the accounts that have an active delegate, from getTokenAccountsByOwner (jsonParsed)
 * `result.value`. An account with no delegate, or with a delegate and amount 0, is not a row.
 * An entry that does not look like a token account throws: an odd response must not read as
 * "no approvals".
 */
export function parseDelegations(entries: unknown[]): Delegation[] {
  const out: Delegation[] = []
  for (const entry of entries) {
    const e = entry as ParsedTokenAccount | null
    const info = e?.account?.data?.parsed?.info
    const programId = e?.account?.owner
    if (
      typeof e?.pubkey !== 'string' ||
      typeof programId !== 'string' ||
      !TOKEN_PROGRAMS.includes(programId) ||
      e.account?.data?.parsed?.type !== 'account' ||
      !info ||
      typeof info.mint !== 'string'
    ) {
      throw new Error('unexpected token account in the RPC response')
    }
    if (info.delegate == null) continue
    const delegated = rawAmount(info.delegatedAmount)
    const balance = rawAmount(info.tokenAmount)
    if (typeof info.delegate !== 'string' || delegated === null || balance === null) {
      throw new Error('unexpected token account in the RPC response')
    }
    if (delegated === 0n) continue
    const ui = (info.delegatedAmount as { uiAmountString?: unknown }).uiAmountString
    out.push({
      account: e.pubkey,
      mint: info.mint,
      programId,
      delegate: info.delegate,
      delegatedRaw: delegated,
      delegatedUi: typeof ui === 'string' ? ui : delegated.toString(),
      kind: delegated === U64_MAX ? 'UNLIMITED' : delegated >= balance ? 'FULL_BALANCE' : 'AMOUNT',
      frozen: info.state === 'frozen',
    })
  }
  return out
}

async function rpc(fetchFn: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const body = (await res.json()) as { result?: { value?: unknown }; error?: { message?: string } }
  if (body?.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`)
  if (!body?.result || !('value' in body.result)) throw new Error(`unexpected ${method} response`)
  return body.result.value
}

/**
 * Active token approvals of `owner`: one call per token program. A failure of EITHER call
 * (HTTP, JSON-RPC error, odd shape, timeout including a stalled body) throws; it never
 * returns a partial or empty list.
 */
export async function fetchDelegations(
  owner: string,
  rpcUrl: string,
  fetchFn: typeof fetch = (u, i) => globalThis.fetch(u, i),
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<Delegation[]> {
  const f = fetchWithTimeout(fetchFn, timeoutMs, 'Token approvals lookup')
  const lists = await Promise.all(
    TOKEN_PROGRAMS.map(async (programId) => {
      const value = await rpc(f, rpcUrl, 'getTokenAccountsByOwner', [
        owner,
        { programId },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ])
      if (!Array.isArray(value)) throw new Error('unexpected getTokenAccountsByOwner response')
      return parseDelegations(value)
    }),
  )
  return lists.flat()
}

/**
 * Does `account` still have an active delegate? Read again from chain; used to confirm a revoke.
 * A closed account has none. Any RPC failure or odd shape throws (never "no delegate").
 */
export async function hasActiveDelegate(
  account: string,
  rpcUrl: string,
  fetchFn: typeof fetch = (u, i) => globalThis.fetch(u, i),
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<boolean> {
  const f = fetchWithTimeout(fetchFn, timeoutMs, 'Token approval check')
  const value = await rpc(f, rpcUrl, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  if (value === null) return false
  return parseDelegations([{ pubkey: account, account: value }]).length > 0
}
