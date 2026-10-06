import { describe, expect, it } from 'vitest'
import {
  ANS_SHADOWED_TLDS,
  deriveNameAccount,
  deriveTldAccount,
  deriveTldHouse,
  parseName,
  resolveName,
} from '../src/pay/names'
import { resolveRecipientInput } from '../src/pay/recipient'
import live from './fixtures/ans-mainnet.json'

// Live mainnet getMultipleAccounts([tldHouse, tldAccount, nameAccount]) responses, captured by hand
// from the public RPC. Name-account owners were replaced by synthetic keys (no private wallets).
const RPC = 'https://rpc.test'
const NOW = Date.parse(live.capturedAt)
type Case = (typeof live.cases)['plain']
const C = live.cases as unknown as Record<string, Case>

type Reply = { status?: number; body: unknown } | 'hang' | 'stall-body' | Error
function fakeFetch(reply: Reply, seen: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${init.body}` : ''}`)
    if (reply === 'hang') return new Promise(() => {})
    if (reply === 'stall-body') {
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: () => new Promise(() => {}) }
    }
    if (reply instanceof Error) throw reply
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(body, { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
}
const deps = (reply: Reply, seen?: string[]) => ({
  fetch: fakeFetch(reply, seen),
  rpcUrl: RPC,
  timeoutMs: 50,
  now: () => NOW,
})
const replay = (c: Case) => ({ body: c.response })
const owner = (name: string) => (live.syntheticOwners as Record<string, string>)[name]

describe('AllDomains derivation is TLD-generic (checked against live mainnet keys)', () => {
  it('TLD house, TLD account and name account match what mainnet returned', () => {
    for (const c of Object.values(C).filter((v) => typeof v === 'object')) {
      const dot = c.name.lastIndexOf('.')
      const label = c.name.slice(0, dot)
      const tld = c.name.slice(dot + 1)
      expect(
        [deriveTldHouse(tld), deriveTldAccount(tld), deriveNameAccount(label, tld)].map((k) => k.toBase58()),
      ).toEqual(c.keys)
    }
  })
})

describe('generic AllDomains TLDs', () => {
  it('bonk.bonk and miester.poor resolve to the name-account owner in one getMultipleAccounts', async () => {
    const seen: string[] = []
    const r = await resolveName('Bonk.BONK', deps(replay(C.plain), seen))
    expect(r).toEqual({
      ok: true,
      name: 'bonk.bonk',
      tld: 'bonk',
      address: owner('bonk.bonk'),
      source: 'AllDomains (.bonk)',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('"method":"getMultipleAccounts"')
    expect(seen[0]).toContain(JSON.stringify(C.plain.keys))
    const p = await resolveName('miester.poor', deps(replay(C.plain2)))
    expect(p).toEqual({
      ok: true,
      name: 'miester.poor',
      tld: 'poor',
      address: owner('miester.poor'),
      source: 'AllDomains (.poor)',
    })
  })

  it('a TLD with no house on chain is "Name system not supported"', async () => {
    const r = await resolveName('alice.seeker', deps(replay(C.unknownTld)))
    expect(r).toEqual({ ok: false, name: 'alice.seeker', error: 'Name system not supported: .seeker.' })
  })

  it('a TLD house that does not bind to the derived TLD account (live .x) is refused', async () => {
    const r = await resolveName('alice.x', deps(replay(C.unboundTld)))
    expect(!r.ok && r.error).toBe('Name system not supported: .x.')
  })

  it('a TLD house for another TLD (replayed under the wrong name) is refused, not trusted', async () => {
    // The .bonk house/account/name replayed for a .poor lookup: the house's TLD string and parent
    // do not match .poor, so nothing is read from the name account.
    const r = await resolveName('bonk.poor', deps(replay(C.plain)))
    expect(!r.ok && r.error).toBe('Name system not supported: .poor.')
  })

  it('shadowed TLDs (.eth, .com, ...) are refused before any RPC call', async () => {
    for (const tld of Object.keys(ANS_SHADOWED_TLDS)) {
      const seen: string[] = []
      const r = await resolveName(`vitalik.${tld}`, deps('hang', seen))
      expect(!r.ok && r.error).toMatch(new RegExp(`^Name system not supported: \\.${tld} \\(`))
      expect(seen).toHaveLength(0)
    }
  })

  it('expired (live lending.solana, expiry before capture) -> blocked', async () => {
    expect(live.cases.expired_expiresAt * 1000).toBeLessThan(NOW)
    const r = await resolveName('lending.solana', deps(replay(C.expired)))
    expect(!r.ok && r.error).toMatch(/has expired/)
    // Same account before its expiry resolves.
    const before = await resolveName('lending.solana', {
      ...deps(replay(C.expired)),
      now: () => (live.cases.expired_expiresAt - 60) * 1000,
    })
    expect(before.ok).toBe(true)
  })

  it('tokenized (live stake.poor, owner = nft_record PDA) -> blocked', async () => {
    const r = await resolveName('stake.poor', deps(replay(C.tokenized)))
    expect(!r.ok && r.error).toMatch(/tokenized domain/)
  })

  it('unregistered name under a real TLD -> not registered', async () => {
    const body = structuredClone(C.plain.response) as { result: { value: unknown[] } }
    body.result.value[2] = null
    const r = await resolveName('bonk.bonk', deps({ body }))
    expect(!r.ok && r.error).toMatch(/not registered/)
  })

  it('RPC failures fail closed: HTTP error, RPC error, odd shape, network error, timeout, stalled body', async () => {
    const fails: Reply[] = [
      { status: 429, body: {} },
      { body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Connection rate limits exceeded' } } },
      { body: { jsonrpc: '2.0', id: 1, result: { value: [null] } } },
      { body: 'not json' },
      new Error('Network request failed'),
      'hang',
      'stall-body',
    ]
    for (const f of fails) {
      const r = await resolveName('bonk.bonk', deps(f))
      expect(r.ok).toBe(false)
    }
    const t = await resolveName('bonk.bonk', deps('hang'))
    expect(!t.ok && t.error).toMatch(/timed out/)
    const b = await resolveName('bonk.bonk', deps('stall-body'))
    expect(!b.ok && b.error).toMatch(/timed out/)
  })

  it('.sol never goes to the AllDomains .sol TLD (it exists on chain, but users mean SNS)', async () => {
    expect(parseName('alice.sol')?.tld).toBe('sol')
    const seen: string[] = []
    await resolveName('alice.sol', deps({ status: 400, body: { s: 'error', result: 'Unsupported TLD' } }, seen))
    expect(seen[0]).toMatch(/^GET https:\/\/sdk-proxy-v2\.sns\.id\/safe-resolve\/alice\.sol/)
  })
})

describe('recipient field with a generic TLD', () => {
  it('resolves to the address that gets checked; an emoji label is refused as unsupported', async () => {
    const r = await resolveRecipientInput('bonk.bonk', deps(replay(C.plain)))
    expect(r).toEqual({
      ok: true,
      address: owner('bonk.bonk'),
      name: { name: 'bonk.bonk', tld: 'bonk', source: 'AllDomains (.bonk)' },
    })
    const e = await resolveRecipientInput('🔥.bonk', deps('hang'))
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.isName).toBe(true)
    const u = await resolveRecipientInput('alice.seeker', deps(replay(C.unknownTld)))
    expect(!u.ok && u.error).toBe('Could not resolve alice.seeker: Name system not supported: .seeker.')
  })
})
