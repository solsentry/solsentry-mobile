import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ANS_PROGRAM, deriveAnsAccount, deriveSkrNameAccount, parseName, resolveName, ROOT_ANS } from '../src/pay/names'
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
    expect(parseName('alice.eth')?.tld).toBe('eth') // parsed, then refused as a shadowed TLD (names-ans.test.ts)
    expect(parseName('🔥.bonk')).toBeNull()
    expect(parseName('1.5')).toBeNull()
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
