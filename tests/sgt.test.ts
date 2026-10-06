import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSgt, findSgtMint, sgtBadgeText, SGT_GROUP, TOKEN_2022_PROGRAM } from '../src/seeker/sgt'
import real from './fixtures/sgt-mainnet.json'

// Real mainnet responses (public on-chain data), captured 2026-10-06 from api.mainnet-beta.solana.com.
const OWNER = real.owner
const SGT_MINT = 'DBiWzritMCZjoLqyxFyWepnfQdZZuHnudrBvvmFzHeb4'
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const accounts = () => clone(real.getTokenAccountsByOwner.result.value) as any[]
const mintAccount = () => clone(real.getMultipleAccounts.result.value[0]) as any

function exts(m: any): any[] {
  return m.data.parsed.info.extensions
}

describe('findSgtMint (pure)', () => {
  it('real holder: frozen ATA with amount 1 and a mint carrying both extensions -> mint', () => {
    expect(accounts()[0].account.data.parsed.info.state).toBe('frozen')
    expect(findSgtMint(accounts(), { [SGT_MINT]: mintAccount() })).toBe(SGT_MINT)
  })

  it('zero balance (SGT moved or burned out, ATA left open) -> null', () => {
    const a = accounts()
    a[0].account.data.parsed.info.tokenAmount.amount = '0'
    expect(findSgtMint(a, { [SGT_MINT]: mintAccount() })).toBeNull()
  })

  it('only the metadata pointer matches -> null', () => {
    const m = mintAccount()
    exts(m).find((e) => e.extension === 'tokenGroupMember').state.group = 'So11111111111111111111111111111111111111112'
    expect(findSgtMint(accounts(), { [SGT_MINT]: m })).toBeNull()
  })

  it('only the group matches -> null', () => {
    const m = mintAccount()
    exts(m).find((e) => e.extension === 'metadataPointer').state.metadataAddress = SGT_MINT
    expect(findSgtMint(accounts(), { [SGT_MINT]: m })).toBeNull()
  })

  it('group member extension missing entirely -> null', () => {
    const m = mintAccount()
    m.data.parsed.info.extensions = exts(m).filter((e) => e.extension !== 'tokenGroupMember')
    expect(findSgtMint(accounts(), { [SGT_MINT]: m })).toBeNull()
  })

  it('legacy Token program account (or mint) is ignored', () => {
    const a = accounts()
    a[0].account.owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    a[0].account.data.program = 'spl-token'
    expect(findSgtMint(a, { [SGT_MINT]: mintAccount() })).toBeNull()
    const m = mintAccount()
    m.owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    expect(findSgtMint(accounts(), { [SGT_MINT]: m })).toBeNull()
  })

  it('missing mint account -> null', () => {
    expect(findSgtMint(accounts(), { [SGT_MINT]: null })).toBeNull()
  })
})

type Handler = (method: string, params: any[]) => unknown

function rpcFetch(handler: Handler, calls: { method: string; params: any[] }[] = []): typeof fetch {
  return (async (_u: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body))
    calls.push({ method, params })
    const out = handler(method, params)
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out))
  }) as unknown as typeof fetch
}

const realHandler: Handler = (method) =>
  method === 'getTokenAccountsByOwner' ? real.getTokenAccountsByOwner : real.getMultipleAccounts

describe('fetchSgt', () => {
  it('verified, with the RPC calls the skill prescribes', async () => {
    const calls: { method: string; params: any[] }[] = []
    const r = await fetchSgt(OWNER, 'https://rpc', rpcFetch(realHandler, calls))
    expect(r).toEqual({ status: 'verified', mint: SGT_MINT })
    expect(calls[0]).toEqual({
      method: 'getTokenAccountsByOwner',
      params: [OWNER, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }],
    })
    expect(calls[1]).toEqual({ method: 'getMultipleAccounts', params: [[SGT_MINT], { encoding: 'jsonParsed' }] })
    expect(sgtBadgeText(r)).toBe('Seeker Genesis Token: verified (mint DBiW…Heb4)')
  })

  it('zero balance -> none, and the mint is not even fetched', async () => {
    const calls: { method: string; params: any[] }[] = []
    const zero = clone(real.getTokenAccountsByOwner) as any
    zero.result.value[0].account.data.parsed.info.tokenAmount.amount = '0'
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch((m) => (m === 'getTokenAccountsByOwner' ? zero : real.getMultipleAccounts), calls),
    )
    expect(r).toEqual({ status: 'none' })
    expect(calls.map((c) => c.method)).toEqual(['getTokenAccountsByOwner'])
  })

  it('wallet with no Token-2022 accounts -> none', async () => {
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch(() => ({ jsonrpc: '2.0', id: 1, result: { context: {}, value: [] } })),
    )
    expect(r).toEqual({ status: 'none' })
  })

  it('JSON-RPC error -> unknown, never none', async () => {
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } })),
    )
    expect(r.status).toBe('unknown')
    expect(sgtBadgeText(r)).toBe('Seeker Genesis Token: could not check')
  })

  it('HTTP 429 -> unknown', async () => {
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch(() => new Response('busy', { status: 429 })),
    )
    expect(r).toEqual({ status: 'unknown', reason: 'RPC HTTP 429' })
  })

  it('mint lookup fails after the accounts came back -> unknown', async () => {
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch((m) =>
        m === 'getTokenAccountsByOwner' ? real.getTokenAccountsByOwner : new Response('', { status: 503 }),
      ),
    )
    expect(r.status).toBe('unknown')
  })

  it('odd response shape -> unknown, not an empty list', async () => {
    const r = await fetchSgt(
      OWNER,
      'https://rpc',
      rpcFetch(() => ({ jsonrpc: '2.0', id: 1, result: [] })),
    )
    expect(r.status).toBe('unknown')
  })

  it('network error -> unknown', async () => {
    const r = await fetchSgt(OWNER, 'https://rpc', (async () => {
      throw new TypeError('Network request failed')
    }) as unknown as typeof fetch)
    expect(r).toEqual({ status: 'unknown', reason: 'Network request failed' })
  })

  it('SGT group constant matches the live group account', () => {
    expect(
      real.getMultipleAccounts.result.value[0].data.parsed.info.extensions.some(
        (e: any) => e.extension === 'tokenGroupMember' && e.state.group === SGT_GROUP,
      ),
    ).toBe(true)
  })
})

describe('fetchSgt timeouts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('headers arrive but the body stalls -> unknown after the timeout, timer cleared', async () => {
    const stalled = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => new Promise(() => {}),
      }) as unknown as Response) as unknown as typeof fetch
    const p = fetchSgt(OWNER, 'https://rpc', stalled)
    await vi.advanceTimersByTimeAsync(10_001)
    const r = await p
    expect(r.status).toBe('unknown')
    expect((r as { reason: string }).reason).toContain('timed out')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a never-resolving fetch -> unknown', async () => {
    const p = fetchSgt(OWNER, 'https://rpc', (() => new Promise(() => {})) as unknown as typeof fetch)
    await vi.advanceTimersByTimeAsync(10_001)
    expect((await p).status).toBe('unknown')
  })
})
