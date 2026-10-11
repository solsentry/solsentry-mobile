import { ed25519 } from '@noble/curves/ed25519.js'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

import {
  deviceLinkMessage,
  deviceUnlinkMessage,
  extractSignature,
  linkWallet,
  parseStoredWallet,
  pointsStatus,
  unlinkWallet,
  type LinkDeps,
  type WalletSigner,
} from '../src/kyw/account'

const secret = ed25519.utils.randomSecretKey()
const pub = ed25519.getPublicKey(secret)
const ADDRESS = new PublicKey(pub).toBase58()
const enc = (s: string) => new TextEncoder().encode(s)

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fake SolSentry: nonce, link (with `linkAnswers` in order) and unlink, recording what was posted. */
function server(linkAnswers: Response[] = [json(200, { linked: true, wallet: ADDRESS, genesis: true, link_id: 7 })]) {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body))
    posted.push({ path, body })
    if (path === '/v1/kyw/wallet/nonce') {
      return json(200, { nonce: 'N1', issued_at: 'T', expires_in: 300, message: `SIWS for ${body.wallet} N1`, device_message: `kyw-link-v0\n${body.wallet}\nN1` })
    }
    if (path === '/v1/kyw/wallet/link') return linkAnswers.shift() ?? json(500, {})
    if (path === '/v1/kyw/wallet/unlink') return json(200, { unlinked: true })
    return json(404, { error: 'not_found' })
  }) as unknown as typeof globalThis.fetch
  return { fetch, posted }
}

const deps = (over: Partial<LinkDeps> = {}): LinkDeps => ({
  deviceKeyId: 'k1:dev',
  signWithDevice: async (b64) => `dev(${Buffer.from(b64, 'base64').toString()})`,
  fetchSgt: async () => ({ status: 'verified', mint: 'Mint111' }),
  fetch: server().fetch,
  apiBase: 'https://api.test',
  sleep: async () => {},
  now: () => Date.UTC(2026, 9, 9, 18, 0, 0),
  ...over,
})

/** A wallet that authorizes ADDRESS and signs what the server sent with `key`. */
const signer = (key = secret): WalletSigner => async (messageFor) => {
  const message = await messageFor(ADDRESS)
  return { address: ADDRESS, message, signed: ed25519.sign(enc(message), key) }
}

describe('device messages', () => {
  it('match the server (integrations/kyw/device.py)', () => {
    expect(deviceLinkMessage(ADDRESS, 'N1')).toBe(`kyw-link-v0\n${ADDRESS}\nN1`)
    expect(deviceUnlinkMessage(ADDRESS, 7)).toBe(`kyw-unlink-v0\n${ADDRESS}\n7`)
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
  it('signs the server text with the wallet and the device message with the key; keeps what the server accepted', async () => {
    const srv = server()
    const r = await linkWallet(deps({ fetch: srv.fetch }), signer())
    expect(r).toMatchObject({ ok: true, wallet: { address: ADDRESS, linkId: 7, genesis: true, deviceKeyId: 'k1:dev', sgt: { status: 'verified' } } })
    expect(srv.posted.map((p) => p.path)).toEqual(['/v1/kyw/wallet/nonce', '/v1/kyw/wallet/link'])
    const link = srv.posted[1].body
    expect(link).toMatchObject({ device_key_id: 'k1:dev', wallet: ADDRESS, nonce: 'N1', device_sig: `dev(kyw-link-v0\n${ADDRESS}\nN1)` })
    expect(ed25519.verify(Buffer.from(String(link.signature), 'base64'), enc(`SIWS for ${ADDRESS} N1`), pub)).toBe(true)
  })
  it('cancel, timeout and a forged signature link nothing', async () => {
    const reject = (e: unknown): WalletSigner => async () => Promise.reject(e)
    expect(await linkWallet(deps(), reject(new Error('User declined')))).toEqual({ ok: false, reason: 'cancelled' })
    expect(await linkWallet(deps(), reject(Object.assign(new Error('x'), { code: 'ERROR_SESSION_TIMEOUT' })))).toEqual({ ok: false, reason: 'timeout' })
    expect(await linkWallet(deps(), reject(new Error('Timed out waiting for response')))).toEqual({ ok: false, reason: 'timeout' })
    const srv = server()
    expect(await linkWallet(deps({ fetch: srv.fetch }), signer(ed25519.utils.randomSecretKey()))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(srv.posted.map((p) => p.path)).toEqual(['/v1/kyw/wallet/nonce'])
  })
  it('a phone without a hardware key does not ask; a key that will not sign links nothing', async () => {
    expect(await linkWallet(deps({ deviceKeyId: 'r1:' + '0'.repeat(32) }), signer())).toEqual({ ok: false, reason: 'no_device_key' })
    expect(await linkWallet(deps({ signWithDevice: async () => null }), signer())).toEqual({ ok: false, reason: 'no_device_key' })
  })
  it('a server refusal is "server", and a Genesis read the server could not finish is sent again', async () => {
    const refused = await linkWallet(deps({ fetch: server([json(401, { error: 'invalid_nonce' })]).fetch }), signer())
    expect(refused).toEqual({ ok: false, reason: 'server', detail: '401 invalid_nonce' })
    const srv = server([json(503, { error: 'sgt_unverified' }), json(200, { linked: true, wallet: ADDRESS, genesis: false, link_id: 9 })])
    const r = await linkWallet(deps({ fetch: srv.fetch }), signer())
    expect(r).toMatchObject({ ok: true, wallet: { linkId: 9, genesis: false } })
    expect(srv.posted.filter((p) => p.path === '/v1/kyw/wallet/link')).toHaveLength(2)
  })
  it('the key never signs a device message other than the one for this wallet and nonce', async () => {
    const fetch = (async (url: string) =>
      new URL(url).pathname === '/v1/kyw/wallet/nonce'
        ? json(200, { nonce: 'N1', message: 'm', device_message: 'kyw-link-v0\nOTHER\nN1' })
        : json(500, {})) as unknown as typeof globalThis.fetch
    const signed: string[] = []
    const r = await linkWallet(deps({ fetch, signWithDevice: async (b) => (signed.push(b), 'x') }), signer())
    expect(r).toMatchObject({ ok: false, reason: 'server' })
    expect(signed).toEqual([])
  })
  it('an SGT lookup on the phone that fails keeps the link, marked unknown', async () => {
    const r = await linkWallet(deps({ fetchSgt: async () => Promise.reject(new Error('rpc down')) }), signer())
    expect(r.ok && r.wallet.sgt.status).toBe('unknown')
  })
})

describe('unlinkWallet and the stored link', () => {
  const w = { address: ADDRESS, linkId: 7, deviceKeyId: 'k1:dev', linkedAt: 1, genesis: false, sgt: { status: 'none' as const } }
  it('the key signs the link it closes', async () => {
    const srv = server()
    expect(await unlinkWallet({ fetch: srv.fetch, apiBase: 'https://api.test', signWithDevice: deps().signWithDevice }, w)).toBe(true)
    expect(srv.posted[0].body).toEqual({ device_key_id: 'k1:dev', wallet: ADDRESS, link_id: 7, device_sig: `dev(kyw-unlink-v0\n${ADDRESS}\n7)` })
  })
  it('a link stored before the server route (no link id) is dropped', () => {
    expect(parseStoredWallet(JSON.stringify(w))).toEqual(w)
    expect(parseStoredWallet(JSON.stringify({ address: ADDRESS, walletSig: 'x', deviceKeyId: 'k1:dev', synced: false }))).toBeNull()
    expect(parseStoredWallet('nope')).toBeNull()
  })
})

describe('pointsStatus', () => {
  const wallet = (sgt: 'verified' | 'none') => ({
    address: ADDRESS, linkId: 1, genesis: false, deviceKeyId: 'k1:dev', linkedAt: 0,
    sgt: sgt === 'verified' ? { status: 'verified' as const, mint: 'M' } : { status: 'none' as const },
  })
  it('a phone with a hardware key earns, with or without a wallet; the Genesis Token makes it Genesis', () => {
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: wallet('verified') })).toEqual({ earns: true, genesis: true })
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: wallet('none') })).toEqual({ earns: true, genesis: false })
    expect(pointsStatus({ deviceCheck: 'verified', deviceKind: 'key', wallet: null })).toEqual({ earns: true, genesis: false })
    expect(pointsStatus({ deviceCheck: 'not_verified', deviceKind: 'key', wallet: wallet('verified') })).toEqual({ earns: true, genesis: true })
  })
  it('a phone without a hardware key signs nothing and does not earn', () => {
    expect(pointsStatus({ deviceCheck: 'unavailable', deviceKind: 'random', wallet: wallet('verified') })).toEqual({ earns: false, why: 'unsigned' })
  })
})
