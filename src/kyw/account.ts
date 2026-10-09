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

export type LinkResult = { ok: true; wallet: LinkedWallet } | { ok: false; reason: 'cancelled' | 'bad_signature' | 'failed'; detail?: string }

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
    return isCancel(e) ? { ok: false, reason: 'cancelled' } : { ok: false, reason: 'failed', detail: String(e).slice(0, 200) }
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
 * Points in v0 (Crash 09/10): any hardware-attested phone (Seeker or Galaxy) with a signed wallet earns
 * the base; a wallet holding the Seeker Genesis Token is Genesis (badge + multiplier, server side).
 */
export function pointsStatus(p: { deviceCheck: string; deviceKind: 'key' | 'random'; wallet: LinkedWallet | null }):
  | { earns: false; why: 'device_not_verified' | 'link_wallet' }
  | { earns: true; genesis: boolean } {
  if (p.deviceKind !== 'key' || p.deviceCheck !== 'verified') return { earns: false, why: 'device_not_verified' }
  if (!p.wallet) return { earns: false, why: 'link_wallet' }
  return { earns: true, genesis: p.wallet.sgt.status === 'verified' }
}
