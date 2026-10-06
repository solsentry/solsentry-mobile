import { PublicKey } from '@solana/web3.js'

/**
 * Solana Pay URL parsing (https://docs.solanapay.com/spec), modelled on the reference
 * parseURL in github.com/anza-xyz/solana-pay (typescript/packages/solana-pay/core).
 *
 * Pure: no React Native, no network. The query string is parsed by hand because React
 * Native's URLSearchParams is incomplete. A parsed request only fills the form: the
 * recipient check, the amount parser (parseSolToLamports) and the verdict freshness and
 * address-binding rules all still apply before anything is signed.
 */

export const SOL_DECIMALS = 9
const MAX_URL_LENGTH = 2048

export interface TransferRequest {
  kind: 'transfer'
  recipient: string
  /** Decimal string in user units (SOL, or the token's units when splToken is set). */
  amount: string | null
  splToken: string | null
  references: string[]
  label: string | null
  message: string | null
  memo: string | null
}

export interface TransactionRequest {
  kind: 'transaction'
  link: string
  label: string | null
  message: string | null
}

export type SolanaPayRequest = TransferRequest | TransactionRequest

export type ParseResult<T> = { ok: true; request: T } | { ok: false; error: string }

/** Canonical base58 32-byte public key. */
export function isPublicKey(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s
  } catch {
    return false
  }
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/** Split "a=1&b=2&b=3" into ordered pairs. Returns null on a malformed escape. */
function parseQuery(q: string): [string, string][] | null {
  const out: [string, string][] = []
  for (const part of q.split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = decode(i < 0 ? part : part.slice(0, i))
    const v = decode(i < 0 ? '' : part.slice(i + 1))
    if (k === null || v === null) return null
    out.push([k, v])
  }
  return out
}

export function isSolanaPayUrl(input: string): boolean {
  return /^solana:/i.test(input.trim())
}

/** Parse a `solana:` URL into a transfer request or a transaction request. */
export function parseSolanaPayUrl(input: string): ParseResult<SolanaPayRequest> {
  const s = input.trim()
  if (s.length > MAX_URL_LENGTH) return { ok: false, error: 'The payment link is too long.' }
  if (!isSolanaPayUrl(s)) return { ok: false, error: 'Not a Solana Pay link (it must start with "solana:").' }
  const rest = s.slice('solana:'.length)
  const q = rest.indexOf('?')
  const path = q < 0 ? rest : rest.slice(0, q)
  const pairs = parseQuery(q < 0 ? '' : rest.slice(q + 1))
  if (!path) return { ok: false, error: 'The payment link has no recipient.' }
  if (!pairs) return { ok: false, error: 'The payment link is malformed (bad URL encoding).' }

  const first = (k: string) => {
    const hit = pairs.find(([key]) => key === k)
    return hit ? hit[1] : null
  }
  const text = (k: string) => first(k) || null

  // Same rule as the reference parser: a ':' or '%' in the path means an HTTPS link.
  if (/[:%]/.test(path)) {
    const link = decode(path)
    if (!link || !/^https:\/\/[^\s/?#]+/i.test(link)) return { ok: false, error: 'The transaction request link is not an HTTPS URL.' }
    return { ok: true, request: { kind: 'transaction', link, label: text('label'), message: text('message') } }
  }

  if (!isPublicKey(path)) return { ok: false, error: 'The payment link has an invalid recipient address.' }

  const splToken = first('spl-token')
  if (splToken !== null && !isPublicKey(splToken)) return { ok: false, error: 'The payment link has an invalid spl-token mint.' }

  const amount = first('amount')
  if (amount !== null) {
    // Non-negative decimal, leading zero before ".", no sign, no exponent.
    if (!/^\d+(\.\d+)?$/.test(amount)) return { ok: false, error: `The requested amount "${amount}" is not a valid number.` }
    const decimals = amount.split('.')[1]?.length ?? 0
    if (splToken === null && decimals > SOL_DECIMALS) {
      return { ok: false, error: `The requested amount has more than ${SOL_DECIMALS} decimals.` }
    }
  }

  const references = pairs.filter(([k]) => k === 'reference').map(([, v]) => v)
  if (!references.every(isPublicKey)) return { ok: false, error: 'The payment link has an invalid reference key.' }

  return {
    ok: true,
    request: {
      kind: 'transfer',
      recipient: path,
      amount,
      splToken,
      references,
      label: text('label'),
      message: text('message'),
      memo: text('memo'),
    },
  }
}

/** What a scanned QR code can be: a Solana Pay link or a bare address. */
export type Scanned =
  | { kind: 'pay'; request: SolanaPayRequest }
  | { kind: 'address'; address: string }

export function parseScanned(data: string): ParseResult<Scanned> {
  const s = data.trim()
  if (isSolanaPayUrl(s)) {
    const r = parseSolanaPayUrl(s)
    return r.ok ? { ok: true, request: { kind: 'pay', request: r.request } } : r
  }
  if (isPublicKey(s)) return { ok: true, request: { kind: 'address', address: s } }
  return { ok: false, error: 'This QR code is not a Solana address or a Solana Pay link.' }
}

/** Why a transfer request cannot be paid by this app (it still gets checked), or null. */
export function unsupportedReason(r: SolanaPayRequest): string | null {
  if (r.kind === 'transaction') {
    return 'Transaction requests (solana:https://...) are not supported: the app would have to sign a transaction built by a server.'
  }
  if (r.splToken) return 'SPL token payments not supported yet. This app only sends SOL; nothing will be sent.'
  return null
}
