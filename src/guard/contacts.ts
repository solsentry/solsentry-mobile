// Known-contact collection for the address-poisoning (lookalike) check.
// Pure helpers live here so they can be unit tested without React Native or the network.
import type { HistoryEntry } from '../state/history-logic'
import { fetchWithTimeout } from './fetch-timeout'

export const MAX_CONTACTS = 50
/** Most recent signatures read. Each one costs a getTransaction on a rate-limited public RPC. */
const RECENT_SIGNATURES = 10
/** Parallel getTransaction calls. The public RPC limits each method per IP; a batch counts every item. */
const TX_CONCURRENCY = 3
/** Whole lookup (signatures + transactions) must finish in this time; it runs before every check. */
export const CONTACTS_BUDGET_MS = 6000
/** One 429 per transaction is retried once after this pause, if the budget allows. */
const RETRY_429_MS = 400
/** getTransaction answers this for a transaction version newer than maxSupportedTransactionVersion. */
const UNSUPPORTED_TX_VERSION = -32015

/**
 * Addresses the user checked that came back ALLOW; newest first, as stored. WARN rows are
 * left out: History does not record whether a warning was reviewed, and a poisoning address
 * kept as a "contact" would make the real address look like the lookalike.
 */
export function contactsFromHistory(entries: HistoryEntry[]): string[] {
  return entries.filter((e) => e.decision === 'allow').map((e) => e.address)
}

/**
 * Distinct recipients of plain SystemProgram transfers sent BY `wallet`, from
 * getTransaction(jsonParsed) results. Failed transactions and incoming transfers are ignored.
 */
export function recipientsFromParsedTxs(txs: unknown[], wallet: string): string[] {
  const out: string[] = []
  for (const tx of txs) {
    const t = tx as {
      meta?: { err?: unknown } | null
      transaction?: { message?: { instructions?: unknown[] } }
    } | null
    if (!t || (t.meta && t.meta.err)) continue
    for (const ix of t.transaction?.message?.instructions ?? []) {
      const i = ix as { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } }
      if (i.program !== 'system' || i.parsed?.type !== 'transfer') continue
      const { source, destination } = i.parsed.info ?? {}
      if (source === wallet && typeof destination === 'string' && destination !== wallet) out.push(destination)
    }
  }
  return out
}

/** Merge sources in priority order, drop empties/duplicates and the destination itself, cap. */
export function buildContacts(destination: string, sources: string[][], cap = MAX_CONTACTS): string[] {
  const seen = new Set<string>([destination])
  const out: string[] = []
  for (const list of sources) {
    for (const a of list) {
      if (!a || seen.has(a)) continue
      seen.add(a)
      out.push(a)
      if (out.length >= cap) return out
    }
  }
  return out
}

export interface WalletRecipients {
  recipients: string[]
  /** false = the RPC lookup failed and the list is empty because of that, not because there is none. */
  ok: boolean
}

export const CONTACTS_PARTIAL_NOTE = 'Lookalike check used local history only (contact list unavailable).'

/** Make a degraded contact list visible on the verdict. Never changes the decision. */
export function markContactsPartial<V extends { reasons: string[]; explanation: string }>(v: V): V {
  if (v.reasons.includes('CONTACTS_PARTIAL')) return v
  return { ...v, reasons: [...v.reasons, 'CONTACTS_PARTIAL'], explanation: `${v.explanation} ${CONTACTS_PARTIAL_NOTE}` }
}

const walletCache = new Map<string, string[]>()

type Fetch = typeof fetch

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One JSON-RPC call, body included, bounded by what is left of `deadline`. */
async function rpc(fetchFn: Fetch, url: string, deadline: number, method: string, params: unknown[]): Promise<any> {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error('contacts lookup out of time')
  const res = await fetchWithTimeout(fetchFn, left, 'Contacts lookup')(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  // A 429 still carries a JSON-RPC body on this RPC; anything else non-2xx is a failure.
  if (!res.ok && res.status !== 429) throw new Error(`RPC HTTP ${res.status}`)
  return await res.json()
}

type TxOutcome = { tx: unknown } | { skip: true } | { failed: true }

async function fetchTx(fetchFn: Fetch, url: string, deadline: number, signature: string): Promise<TxOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: any
    try {
      r = await rpc(fetchFn, url, deadline, 'getTransaction', [
        signature,
        // Version 1 transactions are live on mainnet; with 0 every one of them comes back as error -32015.
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
      ])
    } catch {
      return { failed: true }
    }
    if (r?.result) return { tx: r.result }
    const code = r?.error?.code
    // A newer transaction version cannot be parsed here; it is skipped, not counted as a lookup failure.
    if (code === UNSUPPORTED_TX_VERSION) return { skip: true }
    if (code === 429 && attempt === 0 && deadline - Date.now() > RETRY_429_MS * 2) {
      await sleep(RETRY_429_MS)
      continue
    }
    // No error and no result: the RPC has no such transaction; nothing to read, not a failure.
    if (!r?.error && r && 'result' in r) return { skip: true }
    return { failed: true }
  }
  return { failed: true }
}

/**
 * Recent outgoing SOL recipients of the connected wallet. Best effort: any RPC problem returns
 * what was read with ok=false (and is not cached, so a later check retries); it must never block a recipient check.
 *
 * No JSON-RPC batches: the public mainnet RPC rate-limits each method per IP and counts every batch
 * item, so a 25-item getTransaction batch came back as 25 x 429 and every check was marked partial.
 * Instead: the last RECENT_SIGNATURES signatures, at most TX_CONCURRENCY getTransaction calls at a
 * time, the whole lookup inside CONTACTS_BUDGET_MS. Successful results are cached in memory for the session.
 */
export async function fetchWalletRecipients(
  wallet: string,
  rpcUrl: string,
  fetchFn: Fetch = fetch,
  budgetMs: number = CONTACTS_BUDGET_MS,
): Promise<WalletRecipients> {
  const hit = walletCache.get(wallet)
  if (hit) return { recipients: hit, ok: true }
  const deadline = Date.now() + budgetMs
  try {
    const sigs = await rpc(fetchFn, rpcUrl, deadline, 'getSignaturesForAddress', [wallet, { limit: RECENT_SIGNATURES }])
    if (!Array.isArray(sigs?.result)) return { recipients: [], ok: false }
    const ok = (sigs.result as { signature: string; err: unknown }[]).filter((s) => !s.err).map((s) => s.signature)
    const outcomes: TxOutcome[] = new Array(ok.length)
    let next = 0
    const worker = async () => {
      while (next < ok.length) {
        const i = next++
        outcomes[i] = await fetchTx(fetchFn, rpcUrl, deadline, ok[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(TX_CONCURRENCY, ok.length) }, worker))
    const txs = outcomes.map((o) => ('tx' in o ? o.tx : null))
    const recipients = recipientsFromParsedTxs(txs, wallet)
    // A failed transaction read means the list may be short: use what came back, say so, do not cache.
    if (outcomes.some((o) => 'failed' in o)) return { recipients, ok: false }
    walletCache.set(wallet, recipients)
    return { recipients, ok: true }
  } catch {
    return { recipients: [], ok: false }
  }
}

export function clearWalletContactsCache(): void {
  walletCache.clear()
}

/** "AbCd...WxYz" so the user can see the matching ends of two addresses. */
export function ends(a: string): string {
  return `${a.slice(0, 4)}...${a.slice(-4)}`
}

/** Block text naming the contact the destination imitates. */
export function lookalikeExplanation(destination: string, contact: string | undefined): string {
  if (!contact) {
    return `Blocked: ${ends(destination)} looks like an address you know (possible address poisoning).`
  }
  return (
    `Blocked: possible address poisoning. ${destination} (${ends(destination)}) imitates your known contact ` +
    `${contact} (${ends(contact)}). The first and last characters match, the middle differs. ` +
    `Copy the address from a source you trust, not from your history.`
  )
}

/** One end matches a contact: common for vanity addresses, so a Warning, not a Block. */
export function partialLookalikeExplanation(destination: string, contact: string): string {
  return (
    `Warning: ${destination} (${ends(destination)}) shares its first or last characters with your contact ` +
    `${contact} (${ends(contact)}). Compare the whole address before sending.`
  )
}
