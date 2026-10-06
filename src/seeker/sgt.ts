// Seeker Genesis Token (SGT) lookup, following Solana Mobile's seeker-genesis-token skill.
// A wallet holds an SGT iff it has a Token-2022 account with a non-zero balance whose MINT has
// BOTH metadataPointer.metadataAddress and tokenGroupMember.group equal to the SGT group.
// This proves the WALLET was activated on a Seeker; it says nothing about the phone running the app.
import { fetchWithTimeout, RPC_TIMEOUT_MS } from '../guard/service'

/** SGT metadata address and group mint: intentionally the same value. Mainnet only. */
export const SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const TOKEN_2022_PARSER = 'spl-token-2022'
/** Most RPC providers reject larger getMultipleAccounts requests. */
const MINT_BATCH = 100

export type SgtResult =
  { status: 'verified'; mint: string } | { status: 'none' } | { status: 'unknown'; reason: string }

interface ParsedAccount {
  owner?: string
  data?: { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } }
}

interface Extension {
  extension?: string
  state?: Record<string, unknown>
}

function isToken2022(acc: ParsedAccount | null | undefined): acc is ParsedAccount {
  return !!acc && acc.owner === TOKEN_2022_PROGRAM && acc.data?.program === TOKEN_2022_PARSER
}

/**
 * Mints of Token-2022 accounts that actually hold a balance. The zero-balance filter is not
 * optional: an SGT moved or burned out of a wallet leaves its ATA open with amount "0", and
 * without the filter every wallet that EVER held one would verify. Frozen accounts are kept:
 * a genuinely held SGT sits in a frozen ATA.
 */
export function heldMints(tokenAccounts: unknown[]): string[] {
  const out: string[] = []
  for (const entry of tokenAccounts) {
    const acc = (entry as { account?: ParsedAccount } | null)?.account
    if (!isToken2022(acc) || acc.data?.parsed?.type !== 'account') continue
    const info = acc.data.parsed.info ?? {}
    const amount = (info.tokenAmount as { amount?: unknown } | undefined)?.amount
    if (typeof amount !== 'string' || amount === '0' || !/^\d+$/.test(amount)) continue
    if (typeof info.mint === 'string' && !out.includes(info.mint)) out.push(info.mint)
  }
  return out
}

/** True when a jsonParsed mint account carries BOTH SGT extensions. One alone is not a partial match. */
export function isSgtMint(mintAccount: unknown): boolean {
  const acc = mintAccount as ParsedAccount | null
  if (!isToken2022(acc) || acc.data?.parsed?.type !== 'mint') return false
  const exts = acc.data.parsed.info?.extensions
  if (!Array.isArray(exts)) return false
  const state = (name: string) => (exts as Extension[]).find((e) => e?.extension === name)?.state
  return state('metadataPointer')?.metadataAddress === SGT_GROUP && state('tokenGroupMember')?.group === SGT_GROUP
}

/**
 * Pure check over jsonParsed RPC shapes: `tokenAccounts` is getTokenAccountsByOwner's
 * result.value, `mintAccounts` maps mint address -> getMultipleAccounts entry. Returns the SGT
 * mint (it identifies the device) or null.
 */
export function findSgtMint(tokenAccounts: unknown[], mintAccounts: Record<string, unknown>): string | null {
  for (const mint of heldMints(tokenAccounts)) {
    if (isSgtMint(mintAccounts[mint])) return mint
  }
  return null
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
  // An odd shape must not read as "no accounts" (that would be a silent 'none').
  if (!Array.isArray(body?.result?.value)) throw new Error(`unexpected ${method} response`)
  return body.result.value
}

/**
 * Look up the SGT held by `owner` on mainnet. Any RPC failure (HTTP, JSON-RPC error, odd shape,
 * timeout including a stalled body) is 'unknown', never 'none'.
 */
export async function fetchSgt(
  owner: string,
  rpcUrl: string,
  fetchFn: typeof fetch = (u, i) => globalThis.fetch(u, i),
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<SgtResult> {
  const f = fetchWithTimeout(fetchFn, timeoutMs, 'Seeker Genesis Token lookup')
  try {
    const accounts = (await rpc(f, rpcUrl, 'getTokenAccountsByOwner', [
      owner,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: 'jsonParsed' },
    ])) as unknown[]
    const mints = heldMints(accounts)
    const byMint: Record<string, unknown> = {}
    for (let i = 0; i < mints.length; i += MINT_BATCH) {
      const batch = mints.slice(i, i + MINT_BATCH)
      const infos = (await rpc(f, rpcUrl, 'getMultipleAccounts', [batch, { encoding: 'jsonParsed' }])) as unknown[]
      if (infos.length !== batch.length) throw new Error('unexpected getMultipleAccounts response')
      batch.forEach((m, j) => (byMint[m] = infos[j]))
    }
    const mint = findSgtMint(accounts, byMint)
    return mint ? { status: 'verified', mint } : { status: 'none' }
  } catch (e) {
    return { status: 'unknown', reason: (e as Error)?.message ?? 'unknown error' }
  }
}

/** "abcd…wxyz" for the badge. */
export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

/** Badge text for the connected wallet. */
export function sgtBadgeText(r: SgtResult): string {
  if (r.status === 'verified') return `Seeker Genesis Token: verified (mint ${shortMint(r.mint)})`
  if (r.status === 'none') return 'No Seeker Genesis Token in this wallet'
  return 'Seeker Genesis Token: could not check'
}

export const SGT_INFO_TEXT = 'This shows the wallet was activated on a Seeker, not that this phone is one.'
