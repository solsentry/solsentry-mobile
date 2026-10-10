// Account = a wallet linked by signature (desenho d8 09/10 §2). The wallet and the install key sign
// the same message, which proves both ends. Until the server route exists (coord), the link is kept
// on the phone as pending and is sent later; nothing here grants points by itself.
import { ed25519 } from '@noble/curves/ed25519.js'
import { PublicKey } from '@solana/web3.js'

import { bytesToBase64 } from '../device/attest-logic'
import type { SgtResult } from '../seeker/sgt'
import { utf8 } from '../kyw-core'

export interface LinkedWallet {
  address: string
  message: string
  /** Ed25519 signature by the wallet over `message`, base64 (64 bytes). */
  walletSig: string
  /** Install key signature over `message` (base64 DER), null without a hardware key. */
  deviceSig: string | null
  deviceKeyId: string
  linkedAt: number
  /** Seeker Genesis Token on this wallet, as last read. */
  sgt: SgtResult
  /** False until the server accepted the link. */
  synced: boolean
}

export interface LinkDeps {
  deviceKeyId: string
  /** Install key over the message bytes (base64 in, base64 DER out), or null. */
  signWithDevice: (messageB64: string) => Promise<string | null>
  fetchSgt: (address: string) => Promise<SgtResult>
  randomBytes: (n: number) => Uint8Array
  now: () => number
}

export type LinkResult = { ok: true; wallet: LinkedWallet } | { ok: false; reason: 'cancelled' | 'timeout' | 'bad_signature' | 'failed'; detail?: string }

export function linkMessage(p: { deviceKeyId: string; address: string; nonce: string; issuedAt: string }): string {
  return [
    'SolSentry account link',
    `wallet:${p.address}`,
    `device:${p.deviceKeyId}`,
    `nonce:${p.nonce}`,
    `issued:${p.issuedAt}`,
  ].join('\n')
}

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
 * One link ceremony. The address is not known before the wallet opens, so the message names it only
 * after authorization: the caller's signWithWallet authorizes, then signs what we build here.
 */
export async function linkWallet(
  deps: LinkDeps,
  address: string,
  signed: () => Promise<Uint8Array>,
  message: string,
  /** When the address is only known after the wallet authorizes (MWA), returns what was signed. */
  late?: () => { address: string; message: string },
): Promise<LinkResult> {
  let raw: Uint8Array
  try {
    raw = await signed()
  } catch (e) {
    if (isCancel(e)) return { ok: false, reason: 'cancelled' }
    if (isTimeout(e)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'failed', detail: String(e).slice(0, 200) }
  }
  if (late) ({ address, message } = late())
  const msg = utf8(message)
  let pubkey: Uint8Array
  try {
    pubkey = new PublicKey(address).toBytes()
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  const sig = extractSignature(msg, raw, pubkey)
  if (!sig) return { ok: false, reason: 'bad_signature' }
  const deviceSig = await deps.signWithDevice(bytesToBase64(msg)).catch(() => null)
  const sgt = await deps.fetchSgt(address).catch((e): SgtResult => ({ status: 'unknown', reason: String(e) }))
  return {
    ok: true,
    wallet: {
      address,
      message,
      walletSig: bytesToBase64(sig),
      deviceSig,
      deviceKeyId: deps.deviceKeyId,
      linkedAt: deps.now(),
      sgt,
      synced: false,
    },
  }
}

/** Builds the message for an address once the wallet has authorized. */
export function newLinkMessage(deps: Pick<LinkDeps, 'deviceKeyId' | 'randomBytes' | 'now'>, address: string): string {
  const nonce = Array.from(deps.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('')
  return linkMessage({ deviceKeyId: deps.deviceKeyId, address, nonce, issuedAt: new Date(deps.now()).toISOString() })
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
  return { earns: true, genesis: p.wallet?.sgt.status === 'verified' }
}
