import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVOKE_ENABLED } from '../src/config'
import { APPROVALS_TEXT, approvalsTabHref, confirmText, kindLabel } from '../src/revoke/copy'
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  fetchDelegations,
  hasActiveDelegate,
  parseDelegations,
} from '../src/revoke/delegations'

const OWNER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'
const DELEGATE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const MINT = 'EPjFWdd5AufqSSeqeaGzuZwTDt1v1BbdkYbFvEA7C1Wv'
const U64_MAX = '18446744073709551615'

function tokenAccount(
  pubkey: string,
  o: { delegate?: string; delegated?: string; balance?: string; program?: string; state?: string } = {},
) {
  const info: Record<string, unknown> = {
    mint: MINT,
    owner: OWNER,
    state: o.state ?? 'initialized',
    tokenAmount: { amount: o.balance ?? '5000000', decimals: 6, uiAmountString: '5' },
  }
  if (o.delegate) {
    info.delegate = o.delegate
    info.delegatedAmount = { amount: o.delegated ?? '0', decimals: 6, uiAmountString: `ui:${o.delegated ?? '0'}` }
  }
  return {
    pubkey,
    account: {
      owner: o.program ?? TOKEN_PROGRAM,
      data: { program: 'spl-token', parsed: { type: 'account', info } },
    },
  }
}

const FOUR = [
  tokenAccount('acc-none'),
  tokenAccount('acc-zero', { delegate: DELEGATE, delegated: '0' }),
  tokenAccount('acc-partial', { delegate: DELEGATE, delegated: '1000000' }),
  tokenAccount('acc-max', { delegate: DELEGATE, delegated: U64_MAX }),
]

describe('parseDelegations', () => {
  it('4 accounts (none, zero, partial, u64 max) give exactly 2 rows, UNLIMITED last', () => {
    const rows = parseDelegations(FOUR)
    expect(rows.map((r) => r.account)).toEqual(['acc-partial', 'acc-max'])
    expect(rows[0]).toMatchObject({ kind: 'AMOUNT', delegate: DELEGATE, mint: MINT, delegatedRaw: 1_000_000n, frozen: false })
    expect(rows[0].delegatedUi).toBe('ui:1000000')
    expect(rows[1].kind).toBe('UNLIMITED')
  })

  it('delegated >= balance is FULL_BALANCE, also on an empty account', () => {
    const k = (delegated: string, balance: string) =>
      parseDelegations([tokenAccount('a', { delegate: DELEGATE, delegated, balance })])[0].kind
    expect(k('5000000', '5000000')).toBe('FULL_BALANCE')
    expect(k('5000001', '5000000')).toBe('FULL_BALANCE')
    expect(k('1', '0')).toBe('FULL_BALANCE')
    expect(k('4999999', '5000000')).toBe('AMOUNT')
    expect(k(U64_MAX, U64_MAX)).toBe('UNLIMITED')
  })

  it('carries the owning program of each account (Token-2022 stays Token-2022) and the frozen state', () => {
    const rows = parseDelegations([
      tokenAccount('a', { delegate: DELEGATE, delegated: '1' }),
      tokenAccount('b', { delegate: DELEGATE, delegated: '1', program: TOKEN_2022_PROGRAM, state: 'frozen' }),
    ])
    expect(rows.map((r) => r.programId)).toEqual([TOKEN_PROGRAM, TOKEN_2022_PROGRAM])
    expect(rows.map((r) => r.frozen)).toEqual([false, true])
  })

  it('an entry that is not a token account throws instead of reading as "no approvals"', () => {
    const bad = [
      null,
      {},
      { pubkey: 'a', account: { owner: '11111111111111111111111111111111', data: { parsed: { type: 'account', info: { mint: MINT } } } } },
      { pubkey: 'a', account: { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { mint: MINT } } } } },
      { pubkey: 'a', account: { owner: TOKEN_PROGRAM, data: ['AAAA', 'base64'] } },
      tokenAccount('a', { delegate: DELEGATE, delegated: 'lots' }),
    ]
    for (const b of bad) expect(() => parseDelegations([b])).toThrow('unexpected token account')
  })
})

type Reply = { status?: number; body?: unknown; hang?: boolean; throws?: boolean }

/** Fake fetch that answers per token program (read from the request params). */
function fakeRpc(byProgram: Record<string, Reply>, calls: string[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: [string, { programId?: string }] }
    const programId = req.params[1]?.programId ?? 'account'
    calls.push(`${req.method}:${programId}`)
    const r = byProgram[programId]
    if (r.throws) throw new TypeError('Network request failed')
    if (r.hang) return new Promise(() => {})
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
}

const ok = (value: unknown): Reply => ({ body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } } })

describe('fetchDelegations', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks both token programs with jsonParsed and merges the rows', async () => {
    const calls: string[] = []
    const rows = await fetchDelegations(
      OWNER,
      'https://rpc',
      fakeRpc(
        {
          [TOKEN_PROGRAM]: ok(FOUR),
          [TOKEN_2022_PROGRAM]: ok([tokenAccount('t22', { delegate: DELEGATE, delegated: '7', program: TOKEN_2022_PROGRAM })]),
        },
        calls,
      ),
    )
    expect(calls.sort()).toEqual(
      [`getTokenAccountsByOwner:${TOKEN_PROGRAM}`, `getTokenAccountsByOwner:${TOKEN_2022_PROGRAM}`].sort(),
    )
    expect(rows.map((r) => r.account)).toEqual(['acc-partial', 'acc-max', 't22'])
    expect(rows[2].programId).toBe(TOKEN_2022_PROGRAM)
  })

  it('a wallet with no token accounts is an empty list', async () => {
    const rows = await fetchDelegations(OWNER, 'https://rpc', fakeRpc({ [TOKEN_PROGRAM]: ok([]), [TOKEN_2022_PROGRAM]: ok([]) }))
    expect(rows).toEqual([])
  })

  const failures: Record<string, Reply> = {
    // A well-formed body under an error status is still a failure.
    'HTTP 500': { status: 500, body: ok([]).body },
    'HTTP 429': { status: 429, body: ok([]).body },
    'JSON-RPC error': { body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } } },
    'no result': { body: { jsonrpc: '2.0', id: 1 } },
    'value is not a list': ok({}),
    'null value': ok(null),
    'network down': { throws: true },
  }
  for (const [name, reply] of Object.entries(failures)) {
    for (const failing of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      it(`${name} on ${failing === TOKEN_PROGRAM ? 'Token' : 'Token-2022'} rejects, never an empty list`, async () => {
        const other = failing === TOKEN_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        const p = fetchDelegations(OWNER, 'https://rpc', fakeRpc({ [failing]: reply, [other]: ok(FOUR) }))
        await expect(p).rejects.toThrow()
      })
    }
  }

  it('a call that never answers rejects after the 10 s limit, even if the other one answered', async () => {
    for (const failing of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const other = failing === TOKEN_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
      const p = fetchDelegations(OWNER, 'https://rpc', fakeRpc({ [failing]: { hang: true }, [other]: ok([]) }))
      const assertion = expect(p).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(10_001)
      await assertion
    }
  })
})

describe('hasActiveDelegate (re-read after a revoke)', () => {
  const read = (value: unknown) => hasActiveDelegate('acc', 'https://rpc', fakeRpc({ account: ok(value) }))

  it('true while the delegate is there, false once it is gone or the account is closed', async () => {
    expect(await read(tokenAccount('x', { delegate: DELEGATE, delegated: '1' }).account)).toBe(true)
    expect(await read(tokenAccount('x').account)).toBe(false)
    expect(await read(null)).toBe(false)
  })

  it('a failed or odd read rejects (it must never confirm a revoke)', async () => {
    await expect(read({ owner: '11111111111111111111111111111111', data: ['', 'base64'] })).rejects.toThrow()
    await expect(hasActiveDelegate('acc', 'https://rpc', fakeRpc({ account: { status: 500, body: {} } }))).rejects.toThrow()
    await expect(hasActiveDelegate('acc', 'https://rpc', fakeRpc({ account: { body: { jsonrpc: '2.0', id: 1 } } }))).rejects.toThrow()
  })
})

describe('Approvals tab', () => {
  it('is on in this build; with the flag off the tab is removed from the tab bar', () => {
    expect(REVOKE_ENABLED).toBe(true)
    expect(approvalsTabHref(false)).toBeNull()
    expect(approvalsTabHref(true)).toBeUndefined()
  })

  it('copy: badges, confirmation, and an empty state that makes no safety claim', () => {
    expect(kindLabel({ kind: 'UNLIMITED' })).toBe('Unlimited')
    expect(kindLabel({ kind: 'FULL_BALANCE' })).toBe('Full balance')
    expect(kindLabel({ kind: 'AMOUNT' })).toBeNull()
    expect(confirmText({ delegate: DELEGATE, mint: MINT })).toBe(
      'Revoke this approval? 9WzD…AWWM will no longer be able to move EPjF…C1Wv from this account. A network fee applies.',
    )
    for (const t of Object.values(APPROVALS_TEXT)) expect(t).not.toMatch(/\bsafe\b|protected|real-time|AI-powered|%/i)
  })
})
