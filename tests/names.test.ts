import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ANS_PROGRAM, deriveAnsAccount, deriveMainDomain, deriveSkrNameAccount, deriveSkrReverseAccount, parseMainDomain, parseName, resolveName, reverseSkr, ROOT_ANS } from '../src/pay/names'
import { nameBlockVerdict, resolveRecipientInput } from '../src/pay/recipient'
import { toUiState } from '../src/ui/verdict'

const OWNER = 'Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v'
const RPC = 'https://rpc.test'

type Reply = { status?: number; body: unknown } | 'hang' | 'stall-body' | Error
function fakeFetch(reply: Reply, seen: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${init.body}` : ''}`)
    if (reply === 'hang') return new Promise(() => {})
    if (reply === 'stall-body') {
      // Headers arrive, the body never does.
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: () => new Promise(() => {}) }
    }
    if (reply instanceof Error) throw reply
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(body, { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
}
const deps = (reply: Reply, seen?: string[]) => ({ fetch: fakeFetch(reply, seen), rpcUrl: RPC, timeoutMs: 50 })

function skrAccount(owner: string, expiresAt = 0n, programOwner = ANS_PROGRAM.toBase58()) {
  const data = new Uint8Array(200)
  data.set(new PublicKey(owner).toBytes(), 40)
  new DataView(data.buffer).setBigUint64(104, expiresAt, true)
  const b64 = Buffer.from(data).toString('base64')
  return { body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { owner: programOwner, data: [b64, 'base64'] } } } }
}

describe('name parsing', () => {
  it('recognises .sol, .sns and .skr; rejects malformed', () => {
    expect(parseName(' Alice.SKR ')).toEqual({ name: 'alice.skr', tld: 'skr', label: 'alice' })
    expect(parseName('bonfida.sol')?.tld).toBe('sol')
    expect(parseName('sub.bonfida.sns')?.label).toBe('sub.bonfida')
    expect(parseName('a.b.c.sol')).toBeNull()
    expect(parseName('a.alice.skr')).toBeNull() // .skr subdomains are a different derivation
    expect(parseName('alice_x.skr')).toBeNull()
    expect(parseName(OWNER)).toBeNull()
    expect(parseName('alice.eth')).toBeNull()
  })
})

describe('.sns / .sol via the SNS proxy', () => {
  it('success returns the address and calls safe-resolve', async () => {
    const seen: string[] = []
    const r = await resolveName('bonfida.sns', deps({ body: { s: 'ok', result: OWNER } }, seen))
    expect(r).toEqual({ ok: true, name: 'bonfida.sns', tld: 'sns', address: OWNER, source: 'SNS' })
    expect(seen[0]).toBe('GET https://sdk-proxy-v2.sns.id/safe-resolve/bonfida.sns')
  })
  it('.sol after the SNS cutoff (Unsupported TLD) fails with an explanation', async () => {
    const r = await resolveName('bonfida.sol', deps({ status: 400, body: { s: 'error', result: 'Unsupported TLD' } }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/not resolving \.sol names/)
  })
  it('not found, mismatch, garbage and server errors fail closed', async () => {
    const nf = await resolveName('nope.sns', deps({ status: 404, body: { s: 'error', result: 'Domain not found' } }))
    expect(!nf.ok && nf.error).toMatch(/not registered/)
    const mm = await resolveName('x.sol', deps({ status: 409, body: { s: 'error', result: 'SRS and SNS resolution mismatch' } }))
    expect(!mm.ok && mm.error).toMatch(/different addresses/)
    expect((await resolveName('x.sns', deps({ body: { s: 'ok', result: 'not-a-key' } }))).ok).toBe(false)
    expect((await resolveName('x.sns', deps({ status: 502, body: 'Bad gateway' }))).ok).toBe(false)
    expect((await resolveName('x.sns', deps(new Error('Network request failed')))).ok).toBe(false)
  })
  it('timeout and a stalled body both fail closed', async () => {
    const r = await resolveName('slow.sns', deps('hang'))
    expect(!r.ok && r.error).toMatch(/timed out/)
    const b = await resolveName('slow.sns', deps('stall-body'))
    expect(!b.ok && b.error).toMatch(/timed out/)
  })
})

describe('.skr via AllDomains ANS on mainnet RPC', () => {
  it('derives the ANS root from hash("ANS") (self-check of hashing and seed order)', () => {
    expect(deriveAnsAccount('ANS').equals(ROOT_ANS)).toBe(true)
  })
  it('success reads the owner at offset 40 of the derived account', async () => {
    const seen: string[] = []
    const r = await resolveName('Alice.skr', deps(skrAccount(OWNER), seen))
    expect(r).toEqual({ ok: true, name: 'alice.skr', tld: 'skr', address: OWNER, source: 'AllDomains (.skr)' })
    expect(seen[0]).toContain(deriveSkrNameAccount('alice').toBase58())
    expect(seen[0].startsWith(`POST ${RPC}`)).toBe(true)
  })
  it('unregistered, expired, wrong program owner, RPC error, timeout -> failure', async () => {
    const nf = await resolveName('nobody.skr', deps({ body: { result: { value: null } } }))
    expect(!nf.ok && nf.error).toMatch(/not registered/)
    const exp = await resolveName('old.skr', { ...deps(skrAccount(OWNER, 1_000n)), now: () => 2_000_000 })
    expect(!exp.ok && exp.error).toMatch(/expired/)
    const live = await resolveName('future.skr', { ...deps(skrAccount(OWNER, 4_000_000_000n)), now: () => 2_000_000 })
    expect(live.ok).toBe(true)
    expect((await resolveName('x.skr', deps(skrAccount(OWNER, 0n, OWNER)))).ok).toBe(false)
    expect((await resolveName('x.skr', deps({ body: { error: { message: 'rate limited' } } }))).ok).toBe(false)
    expect((await resolveName('x.skr', deps({ status: 429, body: {} }))).ok).toBe(false)
    const t = await resolveName('x.skr', deps('hang'))
    expect(!t.ok && t.error).toMatch(/timed out/)
    const b = await resolveName('x.skr', deps('stall-body'))
    expect(!b.ok && b.error).toMatch(/timed out/)
  })
})

describe('recipient field -> address to check', () => {
  it('address passes through, name resolves, failure becomes a Block verdict', async () => {
    expect(await resolveRecipientInput(` ${OWNER} `, deps('hang'))).toEqual({ ok: true, address: OWNER, name: null })
    const named = await resolveRecipientInput('alice.skr', deps(skrAccount(OWNER)))
    expect(named).toEqual({ ok: true, address: OWNER, name: { name: 'alice.skr', tld: 'skr', source: 'AllDomains (.skr)' } })
    const failed = await resolveRecipientInput('alice.skr', deps('hang'))
    expect(failed.ok).toBe(false)
    if (failed.ok) return
    expect(failed.isName).toBe(true)
    const ui = toUiState(nameBlockVerdict(failed.error))
    expect(ui.decision).toBe('block')
    expect(ui.canSend).toBe(false)
    expect(ui.message).toMatch(/Could not resolve alice\.skr/)
    expect((await resolveRecipientInput('hello', deps('hang'))).ok).toBe(false)
    expect((await resolveRecipientInput('a.b.c.sol', deps('hang'))).ok).toBe(false)
  })
})

describe('.skr reverse lookup (wallet -> main domain)', () => {
  const TLD_HOUSE = 'TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S'
  function mainDomainData(domain: string, tld = '.skr', nameAccount = deriveSkrNameAccount(domain)) {
    const enc = new TextEncoder()
    const t = enc.encode(tld)
    const d = enc.encode(domain)
    const data = new Uint8Array(8 + 32 + 4 + t.length + 4 + d.length)
    const view = new DataView(data.buffer)
    data.set(nameAccount.toBytes(), 8)
    view.setUint32(40, t.length, true)
    data.set(t, 44)
    view.setUint32(44 + t.length, d.length, true)
    data.set(d, 48 + t.length)
    return data
  }
  const account = (data: Uint8Array, owner = TLD_HOUSE) => ({
    body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { owner, data: [Buffer.from(data).toString('base64'), 'base64'] } } },
  })
  /** First call answers the main domain, the second the name account. */
  function twoStep(first: { body: unknown }, second: { body: unknown }, seen: string[] = []): typeof fetch {
    let n = 0
    return (async (url: string, init?: RequestInit) => {
      seen.push(String(init?.body))
      const reply = n++ === 0 ? first : second
      return new Response(JSON.stringify(reply.body), { status: 200 })
    }) as unknown as typeof fetch
  }

  it('parses the account layout of tld-parser', () => {
    const m = parseMainDomain(mainDomainData('alice'))
    expect(m?.tld).toBe('.skr')
    expect(m?.domain).toBe('alice')
    expect(m?.nameAccount.equals(deriveSkrNameAccount('alice'))).toBe(true)
    expect(parseMainDomain(new Uint8Array(10))).toBeNull()
    expect(parseMainDomain(mainDomainData('alice').subarray(0, 46))).toBeNull()
  })

  it('returns the name when the main domain is .skr and the wallet still owns it', async () => {
    const seen: string[] = []
    const name = await reverseSkr(OWNER, { fetch: twoStep(account(mainDomainData('alice')), skrAccount(OWNER), seen), rpcUrl: RPC, timeoutMs: 50 })
    expect(name).toBe('alice.skr')
    expect(seen[0]).toContain(deriveMainDomain(new PublicKey(OWNER)).toBase58())
    expect(seen[1]).toContain(deriveSkrNameAccount('alice').toBase58())
  })

  it('hides a name the wallet no longer owns, an expired one, another TLD or a forged account', async () => {
    const other = '11111111111111111111111111111112'
    const run = (first: { body: unknown }, second: { body: unknown }, now?: () => number) =>
      reverseSkr(OWNER, { fetch: twoStep(first, second), rpcUrl: RPC, timeoutMs: 50, now })
    expect(await run(account(mainDomainData('alice')), skrAccount(other))).toBeNull()
    expect(await run(account(mainDomainData('alice')), skrAccount(OWNER, 1_000n), () => 2_000_000)).toBeNull()
    expect(await run(account(mainDomainData('alice', '.abc')), skrAccount(OWNER))).toBeNull()
    expect(await run(account(mainDomainData('alice'), ANS_PROGRAM.toBase58()), skrAccount(OWNER))).toBeNull()
    expect(await run(account(mainDomainData('alice', '.skr', deriveSkrNameAccount('bob'))), skrAccount(OWNER))).toBeNull()
  })

  it('no main domain, an RPC error or a bad address gives null, never a throw', async () => {
    expect(await reverseSkr(OWNER, deps({ body: { result: { value: null } } }))).toBeNull()
    expect(await reverseSkr(OWNER, deps({ status: 500, body: 'x' }))).toBeNull()
    expect(await reverseSkr(OWNER, deps('hang'))).toBeNull()
    expect(await reverseSkr('not-an-address', deps({ body: {} }))).toBeNull()
  })
})

describe('.skr reverse lookup without a main domain (owned names)', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
  function reverseAccount(label: string) {
    const data = new Uint8Array(200 + label.length)
    data.set(new TextEncoder().encode(label), 200)
    return { owner: ANS_PROGRAM.toBase58(), data: [Buffer.from(data).toString('base64'), 'base64'] }
  }
  function byMethod(owned: string[], reverse: (ReturnType<typeof reverseAccount> | null)[], nameOwner: string, seen: string[] = []): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
      seen.push(body.method)
      if (body.method === 'getProgramAccounts') return ok(owned.map((pubkey) => ({ pubkey, account: {} })))
      if (body.method === 'getMultipleAccounts') return ok({ context: { slot: 1 }, value: reverse })
      const key = body.params[0] as string
      if (key === deriveMainDomain(new PublicKey(OWNER)).toBase58()) return ok({ context: { slot: 1 }, value: null })
      return new Response(JSON.stringify(skrAccount(nameOwner).body), { status: 200 })
    }) as unknown as typeof fetch
  }
  const run = (f: typeof fetch) => reverseSkr(OWNER, { fetch: f, rpcUrl: RPC, timeoutMs: 50 })

  it('finds the .skr name the wallet owns when no main domain is set', async () => {
    const seen: string[] = []
    expect(await run(byMethod([deriveSkrNameAccount('crash').toBase58()], [reverseAccount('crash')], OWNER, seen))).toBe('crash.skr')
    expect(seen).toEqual(['getAccountInfo', 'getProgramAccounts', 'getMultipleAccounts', 'getAccountInfo'])
    expect(deriveSkrReverseAccount(deriveSkrNameAccount('crash')).toBase58()).not.toBe(deriveSkrNameAccount('crash').toBase58())
  })

  it('rejects a reverse record whose label does not derive to that name account, or a name owned by someone else', async () => {
    expect(await run(byMethod([deriveSkrNameAccount('crash').toBase58()], [reverseAccount('bob')], OWNER))).toBeNull()
    expect(await run(byMethod([deriveSkrNameAccount('crash').toBase58()], [reverseAccount('crash')], '11111111111111111111111111111112'))).toBeNull()
    expect(await run(byMethod([], [], OWNER))).toBeNull()
  })
})
