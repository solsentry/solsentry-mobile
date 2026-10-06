// "Claim Seeker access": sign in with the wallet (SIWS), then ask the API to grant the Seeker
// benefit to the wallet's Seeker Genesis Token. Every server shape lives in this file, so the
// mapping can be adjusted in one place. Nothing here touches the payment check, verdict or send.
//
// SIWS contract mirrored from solsentry integrations/auth/endpoints.py
// (_build_siws_message, handle_wallet_nonce, handle_wallet_verify, _decode_signature).
import { fetchWithTimeout } from '../guard/service'

export const CLAIM_TIMEOUT_MS = 10_000

/** Fixed statement in the server's SIWS template (endpoints.py SIWS_STATEMENT). */
export const SIWS_STATEMENT = 'Sign this message to authenticate with SolSentry'

/** Byte-for-byte copy of the server's _build_siws_message; the wallet signs its UTF-8 bytes. */
export function buildSiwsMessage(domain: string, uri: string, pubkey: string, nonce: string, issuedAt: string): string {
  return (
    `${domain} wants you to sign in with your Solana account:\n` +
    `${pubkey}\n\n` +
    `${SIWS_STATEMENT}\n\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  )
}

export type ClaimOutcome =
  | { kind: 'granted'; expiresAt: string; benefit: string | null; newlyGranted: boolean }
  | { kind: 'no_sgt' }
  | { kind: 'already_claimed' }
  | { kind: 'retry' }
  | { kind: 'unavailable' }
  | { kind: 'cancelled' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "6 Jan 2027" in UTC: no locale data needed on Hermes, and the day does not shift with the phone's zone. */
export function formatExpiry(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function claimText(o: ClaimOutcome): string {
  switch (o.kind) {
    case 'granted':
      return `Seeker verified: SolSentry Pro free until ${formatExpiry(o.expiresAt)}`
    case 'no_sgt':
      return 'No Seeker Genesis Token in this wallet'
    case 'already_claimed':
      return 'This Seeker was already used to claim'
    case 'retry':
      return 'Could not verify, try again'
    case 'unavailable':
      return 'Not available'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** Ends the flow with a given outcome from anywhere inside it. */
class Stop extends Error {
  constructor(readonly outcome: ClaimOutcome) {
    super(outcome.kind)
  }
}

export interface ClaimDeps<S = unknown> {
  apiBase: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** One wallet session: authorize, let `prepare` build the message for the authorized address, sign it. */
  signIn: (prepare: (address: string) => Promise<Uint8Array>) => Promise<{
    address: string
    signedPayload: Uint8Array
    session: S
  }>
}

export interface ClaimRun<S = unknown> {
  outcome: ClaimOutcome
  /** Address that signed (null when the wallet step did not finish). */
  address: string | null
  /** Refreshed wallet session from the authorize step, for the caller's wallet state. */
  session: S | null
}

/** MWA errors that mean the user said no or closed the wallet (duck-typed: no native import here). */
export function isUserCancel(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  // -1 ERROR_AUTHORIZATION_FAILED, -3 ERROR_NOT_SIGNED (protocol); ERROR_SESSION_CLOSED (wallet closed).
  return code === -1 || code === -3 || code === 'ERROR_SESSION_CLOSED'
}

const SIG_LEN = 64

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The 64-byte ed25519 signature out of an MWA signed payload. Wallets return either the bare
 * signature or the message with the signature appended (what Solana Mobile's own adapter
 * assumes); anything else is refused rather than guessed.
 */
export function extractSignature(signedPayload: Uint8Array, message: Uint8Array): Uint8Array {
  if (signedPayload.length === SIG_LEN) return signedPayload
  if (signedPayload.length === message.length + SIG_LEN) {
    if (sameBytes(signedPayload.subarray(0, message.length), message)) return signedPayload.subarray(message.length)
    if (sameBytes(signedPayload.subarray(SIG_LEN), message)) return signedPayload.subarray(0, SIG_LEN)
  }
  throw new Stop({ kind: 'retry' })
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** 404 = feature or route off; any other non-200 on the auth steps = could not verify. */
function authStatusStop(res: Response): Stop {
  return new Stop({ kind: res.status === 404 ? 'unavailable' : 'retry' })
}

interface NonceFields {
  nonce: string
  domain: string
  uri: string
  issuedAt: string
  message: string
}

/** POST /v1/auth/wallet/nonce {pubkey} -> {nonce, statement, domain, uri, issued_at, expires_at, message}. */
async function postNonce(f: typeof fetch, apiBase: string, pubkey: string): Promise<NonceFields> {
  const res = await f(`${apiBase}/v1/auth/wallet/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  })
  if (res.status !== 200) throw authStatusStop(res)
  const b = await readJson(res)
  const nonce = str(b?.nonce)
  const domain = str(b?.domain)
  const uri = str(b?.uri)
  const issuedAt = str(b?.issued_at)
  const message = str(b?.message)
  if (!nonce || !domain || !uri || !issuedAt || !message) throw new Stop({ kind: 'retry' })
  // Sign only text we rebuilt ourselves for our own address: never a server-chosen string.
  if (b?.statement !== SIWS_STATEMENT) throw new Stop({ kind: 'retry' })
  if (buildSiwsMessage(domain, uri, pubkey, nonce, issuedAt) !== message) throw new Stop({ kind: 'retry' })
  return { nonce, domain, uri, issuedAt, message }
}

/**
 * POST /v1/auth/wallet/verify {pubkey, nonce, signature, issued_at} -> {user, session_token}.
 * The signature goes as a list of 64 ints (the first branch of the server's _decode_signature).
 */
async function postVerify(
  f: typeof fetch,
  apiBase: string,
  pubkey: string,
  n: NonceFields,
  signature: Uint8Array,
): Promise<string> {
  const res = await f(`${apiBase}/v1/auth/wallet/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey, nonce: n.nonce, signature: Array.from(signature), issued_at: n.issuedAt }),
  })
  if (res.status !== 200) throw authStatusStop(res)
  const token = str((await readJson(res))?.session_token)
  if (!token) throw new Stop({ kind: 'retry' })
  return token
}

/** Maps a /v1/seeker/claim (or /status) reply to an outcome. Shape per the server contract. */
export function mapClaimResponse(status: number, body: Record<string, unknown> | null): ClaimOutcome {
  if (status === 404) return { kind: 'unavailable' }
  if (status === 409) return body?.error === 'sgt_already_claimed' ? { kind: 'already_claimed' } : { kind: 'retry' }
  if (status !== 200 || !body) return { kind: 'retry' }
  if (body.eligible === false) return { kind: 'no_sgt' }
  if (body.eligible !== true || typeof body.granted !== 'boolean') return { kind: 'retry' }
  const expiresAt = str(body.expires_at)
  if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime())) return { kind: 'retry' }
  return { kind: 'granted', expiresAt, benefit: str(body.benefit), newlyGranted: body.granted }
}

/** POST /v1/seeker/claim with the SIWS session as a Bearer token. */
async function postClaim(f: typeof fetch, apiBase: string, token: string): Promise<ClaimOutcome> {
  const res = await f(`${apiBase}/v1/seeker/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  })
  return mapClaimResponse(res.status, await readJson(res))
}

/** GET /v1/seeker/status for an existing session token. Not used by the screen yet. */
export async function getSeekerStatus(
  apiBase: string,
  token: string,
  fetchFn: typeof fetch = (u, i) => globalThis.fetch(u, i),
  timeoutMs: number = CLAIM_TIMEOUT_MS,
): Promise<ClaimOutcome> {
  const f = fetchWithTimeout(fetchFn, timeoutMs, 'Seeker status request')
  try {
    const res = await f(`${apiBase}/v1/seeker/status`, { headers: { authorization: `Bearer ${token}` } })
    return mapClaimResponse(res.status, await readJson(res))
  } catch {
    return { kind: 'retry' }
  }
}

/**
 * nonce -> sign (inside one wallet session) -> verify -> claim. The session token lives only in
 * this function's scope: it is never stored or returned. Never throws.
 */
export async function claimSeekerAccess<S>(deps: ClaimDeps<S>): Promise<ClaimRun<S>> {
  const f = fetchWithTimeout(
    deps.fetch ?? ((u, i) => globalThis.fetch(u, i)),
    deps.timeoutMs ?? CLAIM_TIMEOUT_MS,
    'Seeker claim request',
  )
  let nonce: NonceFields | null = null
  let message: Uint8Array | null = null
  let signed: { address: string; signedPayload: Uint8Array; session: S }
  try {
    signed = await deps.signIn(async (address) => {
      nonce = await postNonce(f, deps.apiBase, address)
      message = new TextEncoder().encode(nonce.message)
      return message
    })
  } catch (e) {
    if (e instanceof Stop) return { outcome: e.outcome, address: null, session: null }
    return { outcome: isUserCancel(e) ? { kind: 'cancelled' } : { kind: 'retry' }, address: null, session: null }
  }
  const { address, session } = signed
  try {
    const n = nonce as NonceFields | null
    const m = message as Uint8Array | null
    if (!n || !m) throw new Stop({ kind: 'retry' })
    const signature = extractSignature(signed.signedPayload, m)
    const token = await postVerify(f, deps.apiBase, address, n, signature)
    return { outcome: await postClaim(f, deps.apiBase, token), address, session }
  } catch (e) {
    return { outcome: e instanceof Stop ? e.outcome : { kind: 'retry' }, address, session }
  }
}
