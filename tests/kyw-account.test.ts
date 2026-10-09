import { ed25519 } from '@noble/curves/ed25519.js'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

import { extractSignature, linkWallet, newLinkMessage, pointsStatus, type LinkDeps } from '../src/kyw/account'

const secret = ed25519.utils.randomSecretKey()
const pub = ed25519.getPublicKey(secret)
const ADDRESS = new PublicKey(pub).toBase58()
const enc = (s: string) => new TextEncoder().encode(s)

const deps = (over: Partial<LinkDeps> = {}): LinkDeps => ({
  deviceKeyId: 'k1:dev',
  signWithDevice: async (b64) => `dev(${b64.length})`,
  fetchSgt: async () => ({ status: 'verified', mint: 'Mint111' }),
  randomBytes: (n) => new Uint8Array(n).fill(1),
  now: () => Date.UTC(2026, 9, 9, 18, 0, 0),
  ...over,
})

describe('link message', () => {
  it('names the wallet, the install, a nonce and the time', () => {
    const m = newLinkMessage(deps(), ADDRESS)
    expect(m).toBe(`SolSentry account link\nwallet:${ADDRESS}\ndevice:k1:dev\nnonce:${'01'.repeat(16)}\nissued:2026-10-09T18:00:00.000Z`)
  })
})

describe('extractSignature', () => {
  const msg = enc('hello')
  const sig = ed25519.sign(msg, secret)
  it('accepts a bare signature, message+signature and signature+message', () => {
    expect(extractSignature(msg, sig, pub)).toEqual(sig)
    expect(extractSignature(msg, new Uint8Array([...msg, ...sig]), pub)).toEqual(sig)
    expect(extractSignature(msg, new Uint8Array([...sig, ...msg]), pub)).toEqual(sig)
  })
  it('refuses a signature by another key or over another message', () => {
    expect(extractSignature(enc('other'), sig, pub)).toBeNull()
    expect(extractSignature(msg, sig, ed25519.getPublicKey(ed25519.utils.randomSecretKey()))).toBeNull()
  })
})

describe('linkWallet', () => {
  it('a valid wallet signature links, with the device signature and the SGT read', async () => {
    const m = newLinkMessage(deps(), ADDRESS)
    const r = await linkWallet(deps(), ADDRESS, async () => ed25519.sign(enc(m), secret), m)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wallet).toMatchObject({ address: ADDRESS, deviceKeyId: 'k1:dev', synced: false, sgt: { status: 'verified' } })
    expect(r.wallet.deviceSig).toMatch(/^dev\(/)
    expect(Buffer.from(r.wallet.walletSig, 'base64')).toHaveLength(64)
  })
  it('the user cancelling in the wallet is "cancelled", a forged signature is refused', async () => {
    const m = newLinkMessage(deps(), ADDRESS)
    expect(await linkWallet(deps(), ADDRESS, async () => Promise.reject(new Error('User declined')), m)).toEqual({ ok: false, reason: 'cancelled' })
    expect(await linkWallet(deps(), ADDRESS, async () => new Uint8Array(64), m)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('an SGT lookup that fails keeps the link, marked unknown', async () => {
    const m = newLinkMessage(deps(), ADDRESS)
    const r = await linkWallet(deps({ fetchSgt: async () => Promise.reject(new Error('rpc down')) }), ADDRESS, async () => ed25519.sign(enc(m), secret), m)
    expect(r.ok && r.wallet.sgt.status).toBe('unknown')
  })
})

describe('pointsStatus', () => {
  const wallet = (sgt: 'verified' | 'none') => ({
    address: ADDRESS, message: '', walletSig: '', deviceSig: null, deviceKeyId: 'k1:dev', linkedAt: 0, synced: false,
    sgt: sgt === 'verified' ? { status: 'verified' as const, mint: 'M' } : { status: 'none' as const },
  })
  it('attested phone + signed wallet earns; the Genesis Token makes it Genesis', () => {
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: wallet('verified') })).toEqual({ earns: true, genesis: true })
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: wallet('none') })).toEqual({ earns: true, genesis: false })
  })
  it('no wallet, or a phone that is not attested, does not earn', () => {
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: null })).toEqual({ earns: false, why: 'link_wallet' })
    expect(pointsStatus({ deviceCheck: 'not_verified', deviceKind: 'key', wallet: wallet('verified') })).toEqual({ earns: false, why: 'device_not_verified' })
    expect(pointsStatus({ deviceCheck: 'unavailable', deviceKind: 'random', wallet: wallet('verified') })).toEqual({ earns: false, why: 'device_not_verified' })
  })
})
