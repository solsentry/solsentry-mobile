// Known-contact collection for the address-poisoning (lookalike) check.
// Pure helpers live here so they can be unit tested without React Native or the network.
import type { HistoryEntry } from '../state/history-logic'

export const MAX_CONTACTS = 50
const RECENT_SIGNATURES = 25
const RPC_TIMEOUT_MS = 8000

/** Addresses the user checked and let through (ALLOW or WARN); newest first, as stored. */
export function contactsFromHistory(entries: HistoryEntry[]): string[] {
  return entries.filter((e) => e.decision === 'allow' || e.decision === 'warn').map((e) => e.address)
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

async function rpc(fetchFn: Fetch, url: string, body: unknown): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recent outgoing SOL recipients of the connected wallet. Best effort: any RPC problem returns
 * an empty list with ok=false (and is not cached, so a later check retries); it must never block a recipient check.
 * Successful results are cached in memory for the session.
 */
export async function fetchWalletRecipients(
  wallet: string,
  rpcUrl: string,
  fetchFn: Fetch = fetch,
): Promise<WalletRecipients> {
  const hit = walletCache.get(wallet)
  if (hit) return { recipients: hit, ok: true }
  try {
    const sigs = await rpc(fetchFn, rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [wallet, { limit: RECENT_SIGNATURES }],
    })
    if (!Array.isArray(sigs?.result)) return { recipients: [], ok: false }
    const ok = (sigs.result as { signature: string; err: unknown }[]).filter((s) => !s.err).map((s) => s.signature)
    if (ok.length === 0) {
      walletCache.set(wallet, [])
      return { recipients: [], ok: true }
    }
    const batch = await rpc(
      fetchFn,
      rpcUrl,
      ok.map((signature, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      })),
    )
    if (!Array.isArray(batch)) return { recipients: [], ok: false }
    const recipients = recipientsFromParsedTxs(
      batch.map((r: { result?: unknown }) => r?.result),
      wallet,
    )
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
