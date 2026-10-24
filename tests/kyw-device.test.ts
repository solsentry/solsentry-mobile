import { describe, expect, it } from 'vitest'

import { DEVICE_ALIAS, ensureDevice, parseIdentity, resultSigningPayload, signResult, type DeviceDeps, type DeviceNative } from '../src/kyw/device'

const API = 'https://api.example.test'
const CHALLENGE = 'A'.repeat(42) + 'A='
const SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'a+b/'.repeat(20)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const GENUINE = {
  valid: true,
  challenge_match: true,
  security_level: 'TrustedEnvironment',
  root_of_trust: { verified_boot_state: 'Verified', device_locked: true },
  attested_ids: { manufacturer: 'Solana Mobile Inc.', model: 'Seeker', brand: 'solanamobile' },
  revoked: false,
  revocation_checked: true,
}

function nativeFake(opts: { has?: boolean; chain?: string[]; spki?: string | null } = {}) {
  let has = opts.has ?? false
  const attests: { challenge: string; keepAlias?: string; strongBox: boolean }[] = []
  const n: DeviceNative = {
    isAvailable: () => true,
    hasKey: () => has,
    publicKey: () => (has ? (opts.spki === undefined ? SPKI : opts.spki) : null),
    attestKey: async (challenge, o) => {
      attests.push({ challenge, keepAlias: o.keepAlias, strongBox: o.strongBox })
      const chain = opts.chain ?? ['leaf', 'root']
      if (chain.length) has = true
      return { chain, strongBox: false, idAttestation: 'included', claimed: { manufacturer: 'Solana Mobile Inc.', brand: 'solanamobile', model: 'Seeker', sdkInt: 35 } }
    },
    sign: async (_alias, data) => `sig(${data})`,
  }
  return { n, attests }
}

function deps(native: DeviceNative | null, server: (url: string, init?: RequestInit) => Response, stored: string | null = null) {
  const saved: string[] = []
  const calls: string[] = []
  const d: DeviceDeps = {
    fetch: (async (u: RequestInfo | URL, i?: RequestInit) => {
      calls.push(String(u))
      return server(String(u), i)
    }) as typeof fetch,
    apiBase: API,
    native,
    load: async () => stored,
    save: async (raw) => void saved.push(raw),
    randomBytes: (n) => new Uint8Array(n).fill(7),
  }
  return { d, saved, calls }
}

const okServer = (verify: unknown = GENUINE) => (url: string) =>
  url.endsWith('/challenge') ? json({ challenge: CHALLENGE }) : json(verify)

describe('ensureDevice', () => {
  it('first run: key created over the server challenge, kept, verified as a genuine Seeker', async () => {
    const { n, attests } = nativeFake()
    const { d, saved, calls } = deps(n, okServer())
    const id = await ensureDevice(d)
    expect(attests).toEqual([{ challenge: CHALLENGE, keepAlias: DEVICE_ALIAS, strongBox: false }])
    expect(calls).toEqual([`${API}/v1/device-attestation/challenge`, `${API}/v1/device-attestation/verify`])
    expect(id.kind).toBe('key')
    expect(id.id.startsWith('k1:')).toBe(true)
    expect(id.id).not.toMatch(/[+/=]/)
    expect(id.check).toBe('verified')
    expect(id.headline).toMatch(/Seeker/)
    expect(parseIdentity(saved[0])).toEqual(id)
  })

  it('sends device_hint on verify only when the native side gives 64 lowercase hex chars', async () => {
    const bodyOf = async (hint?: () => string | null) => {
      const { n } = nativeFake()
      const native = hint ? { ...n, deviceHint: hint } : n
      let body: Record<string, unknown> = {}
      await ensureDevice(
        deps(native, (url, init) => {
          if (url.endsWith('/verify')) body = JSON.parse(String(init?.body))
          return okServer()(url)
        }).d,
      )
      return body
    }
    const good = 'a'.repeat(64)
    expect((await bodyOf(() => good)).device_hint).toBe(good)
    expect(await bodyOf()).not.toHaveProperty('device_hint')
    expect(await bodyOf(() => null)).not.toHaveProperty('device_hint')
    expect(await bodyOf(() => 'A'.repeat(64))).not.toHaveProperty('device_hint')
    expect(await bodyOf(() => '7677aa06e997712c')).not.toHaveProperty('device_hint')
    expect(
      await bodyOf(() => {
        throw new Error('no context')
      }),
    ).toMatchObject({ challenge: CHALLENGE })
  })

  it('later runs reuse the key and make no server call', async () => {
    const first = await ensureDevice(deps(nativeFake().n, okServer()).d)
    const { n, attests } = nativeFake({ has: true })
    const { d, calls } = deps(n, okServer(), JSON.stringify(first))
    expect(await ensureDevice(d)).toEqual(first)
    expect(attests).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('a server that refuses the chain leaves a stable key id, marked not verified', async () => {
    const { n } = nativeFake()
    const id = await ensureDevice(deps(n, okServer({ valid: false, reason: 'untrusted_root' })).d)
    expect(id).toMatchObject({ kind: 'key', check: 'not_verified' })
  })

  it('no challenge from the server: key still created (stable id), check could not run', async () => {
    const { n, attests } = nativeFake()
    const id = await ensureDevice(deps(n, () => json({}, 404)).d)
    expect(id).toMatchObject({ kind: 'key', check: 'could_not_verify', headline: null })
    expect(attests[0].challenge).not.toBe(CHALLENGE)
  })

  it('no native module: random id, stable across runs, never signed', async () => {
    const a = deps(null, okServer())
    const first = await ensureDevice(a.d)
    expect(first).toMatchObject({ kind: 'random', check: 'unavailable' })
    expect(first.id).toMatch(/^r1:[0-9a-f]{32}$/)
    expect(a.calls).toHaveLength(0)
    const b = deps(null, okServer(), a.saved[0])
    expect(await ensureDevice(b.d)).toEqual(first)
    expect(await signResult(null, first, { task_id: 't', status: 'ok', fact_digest: null, rpc_host: 'h' })).toBeNull()
  })

  it('attestation that yields no chain falls back to a random id', async () => {
    const { n } = nativeFake({ chain: [] })
    expect((await ensureDevice(deps(n, okServer()).d)).kind).toBe('random')
  })

  it('stored junk is ignored', () => {
    expect(parseIdentity('{"id":"x","kind":"key"}')).toBeNull()
    expect(parseIdentity('not json')).toBeNull()
  })
})

describe('signResult', () => {
  it('signs the fixed payload with the install key', async () => {
    const { n } = nativeFake({ has: true })
    const r = { task_id: 't1', status: 'ok', fact_digest: 'ab', rpc_host: 'mainnet.helius-rpc.com' }
    expect(resultSigningPayload(r)).toBe('kyw-result-v0\nt1\nok\nab\nmainnet.helius-rpc.com')
    expect(resultSigningPayload({ ...r, rpc_url_digest: 'd'.repeat(64) })).toBe(`kyw-result-v0\nt1\nok\nab\nmainnet.helius-rpc.com\n${'d'.repeat(64)}`)
    const sig = await signResult(n, { id: 'k1:x', kind: 'key', check: 'verified', headline: null }, r)
    expect(sig).toBe(`sig(${Buffer.from(resultSigningPayload(r)).toString('base64')})`)
  })
})
