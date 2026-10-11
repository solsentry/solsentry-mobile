// Account = a wallet linked on the server (desenho d8 09/10 §2, routes in prod since #549). SolSentry
// issues a single-use nonce and the whole Sign-In With Solana text; the wallet signs that text and the
// install key signs the server's device message, so both ends agree. Only a link the server accepted is
// kept on the phone; nothing here grants points by itself.
import { ed25519 } from '@noble/curves/ed25519.js'
import { PublicKey } from '@solana/web3.js'

import { bytesToBase64 } from '../device/attest-logic'
import type { SgtResult } from '../seeker/sgt'
import { utf8 } from '../kyw-core'

export interface LinkedWallet {
  address: string
  /** Id of the link on the server; unlinking names it. */
  linkId: number
  deviceKeyId: string
  linkedAt: number
  /** Seeker Genesis Token on this wallet, as the server found it when linking. */
  genesis: boolean
  /** The same, read by the phone (shows the mint and survives a server that could not check). */
  sgt: SgtResult
}

export interface LinkDeps {
  deviceKeyId: string
  /** Install key over the message bytes (base64 in, base64 DER out), or null. */
  signWithDevice: (messageB64: string) => Promise<string | null>
  fetchSgt: (address: string) => Promise<SgtResult>
  fetch: typeof fetch
  apiBase: string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * Opens the wallet and authorizes; once the address is known, `message(address)` returns the text to
 * sign (it asks the server for it inside the same wallet session).
 */
export type WalletSigner = (
  message: (address: string) => Promise<string>,
) => Promise<{ address: string; message: string; signed: Uint8Array }>

export type LinkFailure = 'cancelled' | 'timeout' | 'bad_signature' | 'no_device_key' | 'server' | 'failed'
export type LinkResult = { ok: true; wallet: LinkedWallet } | { ok: false; reason: LinkFailure; detail?: string }

/** The server's device message for a link: what the install key signs (integrations/kyw/device.py). */
export function deviceLinkMessage(wallet: string, nonce: string): string {
  return ['kyw-link-v0', wallet, nonce].join('\n')
}

/** The install key's consent to close one link. */
export function deviceUnlinkMessage(wallet: string, linkId: number): string {
  return ['kyw-unlink-v0', wallet, String(linkId)].join('\n')
}

class ServerRefused extends Error {}

async function post(deps: Pick<LinkDeps, 'fetch' | 'apiBase'>, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await deps.fetch(`${deps.apiBase}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let out: unknown = null
  try {
    out = await res.json()
  } catch {
    out = null
  }
  return { status: res.status, body: typeof out === 'object' && out !== null ? (out as Record<string, unknown>) : null }
}

const errorOf = (r: { status: number; body: Record<string, unknown> | null }) =>
  typeof r.body?.error === 'string' ? `${r.status} ${r.body.error}` : `HTTP ${r.status}`

/**
 * Wallets differ in what sign_messages returns: the bare 64-byte signature, or the message with the
 * signature appended (or prepended). Returns the signature only if it verifies against `pubkey`.
 */
export function extractSignature(message: Uint8Array, signed: Uint8Array, pubkey: Uint8Array): Uint8Array | null {
  const candidates: Uint8Array[] = []
  if (signed.length === 64) candidates.push(signed)
  if (signed.length === message.length + 64) candidates.push(signed.slice(message.length), signed.slice(0, 64))
  for (const sig of candidates) {
    try {
      if (ed25519.verify(sig, message, pubkey)) return sig
    } catch {
      // not this layout
    }
  }
  return null
}

const isCancel = (e: unknown) => /cancel|declin|reject|denied/i.test(e instanceof Error ? e.message : String(e))

/** The wallet opened but nobody answered before the session's own limit (90 s in the library). */
const isTimeout = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ERROR_SESSION_TIMEOUT' || /timed? ?out|timeout/i.test(e instanceof Error ? e.message : String(e))
}

/**
 * One link ceremony: wallet session (authorize, server nonce, wallet signs the SIWS text), then the
 * install key signs the device message and the server checks both. A Genesis lookup the server could
 * not finish leaves the nonce unspent, so the same link is sent again a few seconds later.
 */
export async function linkWallet(deps: LinkDeps, signer: WalletSigner): Promise<LinkResult> {
  if (!deps.deviceKeyId.startsWith('k1:')) return { ok: false, reason: 'no_device_key' }
  let nonce: { nonce: string; device_message: string } | null = null
  let got: { address: string; message: string; signed: Uint8Array }
  try {
    got = await signer(async (address) => {
      const r = await post(deps, '/v1/kyw/wallet/nonce', { device_key_id: deps.deviceKeyId, wallet: address })
      const b = r.body
      if (r.status !== 200 || typeof b?.nonce !== 'string' || typeof b.message !== 'string' || typeof b.device_message !== 'string') {
        throw new ServerRefused(errorOf(r))
      }
      nonce = { nonce: b.nonce, device_message: b.device_message }
      return b.message
    })
  } catch (e) {
    if (e instanceof ServerRefused) return { ok: false, reason: 'server', detail: e.message }
    if (isCancel(e)) return { ok: false, reason: 'cancelled' }
    if (isTimeout(e)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'failed', detail: String(e).slice(0, 200) }
  }
  const issued = nonce as { nonce: string; device_message: string } | null
  if (!issued) return { ok: false, reason: 'failed', detail: 'no nonce' }
  const { address } = got
  let pubkey: Uint8Array
  try {
    pubkey = new PublicKey(address).toBytes()
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  const sig = extractSignature(utf8(got.message), got.signed, pubkey)
  if (!sig) return { ok: false, reason: 'bad_signature' }
  // The server sends the device message too; it must be the one we expect, or the key would sign
  // something we did not read.
  if (issued.device_message !== deviceLinkMessage(address, issued.nonce)) return { ok: false, reason: 'server', detail: 'unexpected device message' }
  const deviceSig = await deps.signWithDevice(bytesToBase64(utf8(issued.device_message))).catch(() => null)
  if (!deviceSig) return { ok: false, reason: 'no_device_key' }
  const body = { device_key_id: deps.deviceKeyId, wallet: address, nonce: issued.nonce, signature: bytesToBase64(sig), device_sig: deviceSig }
  let r: Awaited<ReturnType<typeof post>> | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await post(deps, '/v1/kyw/wallet/link', body)
    } catch (e) {
      return { ok: false, reason: 'server', detail: String(e).slice(0, 200) }
    }
    if (!(r.status === 503 && r.body?.error === 'sgt_unverified')) break
    await deps.sleep(5_000)
  }
  if (!r || r.status !== 200 || r.body?.linked !== true || typeof r.body.link_id !== 'number') {
    return { ok: false, reason: 'server', detail: r ? errorOf(r) : 'no answer' }
  }
  const sgt = await deps.fetchSgt(address).catch((e): SgtResult => ({ status: 'unknown', reason: String(e) }))
  return {
    ok: true,
    wallet: { address, linkId: r.body.link_id, deviceKeyId: deps.deviceKeyId, linkedAt: deps.now(), genesis: r.body.genesis === true, sgt },
  }
}

/** Closes the link on the server. True when the server no longer holds it (closed now or before). */
export async function unlinkWallet(deps: Pick<LinkDeps, 'fetch' | 'apiBase' | 'signWithDevice'>, wallet: LinkedWallet): Promise<boolean> {
  const deviceSig = await deps
    .signWithDevice(bytesToBase64(utf8(deviceUnlinkMessage(wallet.address, wallet.linkId))))
    .catch(() => null)
  if (!deviceSig) return false
  try {
    const r = await post(deps, '/v1/kyw/wallet/unlink', {
      device_key_id: wallet.deviceKeyId,
      wallet: wallet.address,
      link_id: wallet.linkId,
      device_sig: deviceSig,
    })
    return r.status === 200 && typeof r.body?.unlinked === 'boolean'
  } catch {
    return false
  }
}

/** A stored link from before the server route (no link id) is not a link: it is dropped. */
export function parseStoredWallet(raw: string | null): LinkedWallet | null {
  if (!raw) return null
  try {
    const w = JSON.parse(raw) as Partial<LinkedWallet>
    if (typeof w?.address !== 'string' || typeof w.linkId !== 'number' || typeof w.deviceKeyId !== 'string') return null
    return {
      address: w.address,
      linkId: w.linkId,
      deviceKeyId: w.deviceKeyId,
      linkedAt: typeof w.linkedAt === 'number' ? w.linkedAt : 0,
      genesis: w.genesis === true,
      sgt: w.sgt && typeof w.sgt === 'object' && 'status' in w.sgt ? w.sgt : { status: 'unknown', reason: 'not stored' },
    }
  } catch {
    return null
  }
}

/**
 * Points rev. 2 (Crash 10/10): a phone with a hardware key signs its results and earns the base; a wallet
 * holding the Seeker Genesis Token is Genesis (badge now, multiplier planned, server side).
 */
export function pointsStatus(p: { deviceCheck: string; deviceKind: 'key' | 'random'; wallet: LinkedWallet | null }):
  | { earns: false; why: 'unsigned' }
  | { earns: true; genesis: boolean } {
  // Rule rev. 2 (10/10): any signed result counts; attestation and Genesis only change the cap and
  // the planned multipliers, and a wallet keeps the points beyond this install.
  if (p.deviceKind !== 'key') return { earns: false, why: 'unsigned' }
  return { earns: true, genesis: p.wallet?.genesis === true || p.wallet?.sgt.status === 'verified' }
}
