import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildContacts,
  clearWalletContactsCache,
  CONTACTS_BUDGET_MS,
  contactsFromHistory,
  fetchWalletRecipients,
  lookalikeExplanation,
  markContactsPartial,
  recipientsFromParsedTxs,
} from '../src/guard/contacts'
import { normalizeLookalike, screenRecipient } from '../src/guard/service'

const W = 'WalletWalletWalletWalletWalletWalletWallet1'
const REAL = '4kxscuteRLQdNiTXA33YYsvywAPNA6DQTifswxjL5pH1'
const FAKE = '4kxs11111111111111111111111111111swxjL5pH1'

const h = (address: string, decision: 'allow' | 'warn' | 'block') => ({
  address,
  decision,
  explanation: '',
  checkedAt: 1,
})
const transfer = (source: string, destination: string, err: unknown = null) => ({
  meta: { err },
  transaction: {
    message: {
      instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 1 } } }],
    },
  },
})

const SIGS = (n: number) => Array.from({ length: n }, (_, i) => ({ signature: `s${i}`, err: null }))

type Reply = { result?: unknown; error?: unknown; status?: number }
/** Fake single-call JSON-RPC server; fails the test if it ever receives a batch. */
function server(handle: (b: { method: string; params: any[] }) => Reply | Promise<Reply>): typeof fetch {
  return (async (_u: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body))
    if (Array.isArray(body)) throw new Error('batch request sent')
    const { status = 200, ...rest } = await handle(body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...rest }), { status })
  }) as unknown as typeof fetch
}

describe('contacts', () => {
  beforeEach(() => clearWalletContactsCache())

  it('history: only allow counts; warn and block do not', () => {
    expect(contactsFromHistory([h('a', 'allow'), h('b', 'block'), h('c', 'warn')])).toEqual(['a'])
  })

  it('parsed txs: only outgoing, successful system transfers', () => {
    const txs = [
      transfer(W, 'x'),
      transfer('other', W),
      transfer(W, 'y', { InstructionError: 1 }),
      null,
      transfer(W, 'x'),
    ]
    expect(recipientsFromParsedTxs(txs, W)).toEqual(['x', 'x'])
  })

  it('build: dedupe, exclude destination, cap', () => {
    expect(
      buildContacts('d', [
        ['a', 'd', 'b'],
        ['a', 'c', ''],
      ]),
    ).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 80 }, (_, i) => `k${i}`)
    expect(buildContacts('d', [many])).toHaveLength(50)
  })

  it('RPC failure -> [] without throwing; success is cached', async () => {
    const bad = (async () => {
      throw new Error('boom')
    }) as never
    expect(await fetchWalletRecipients(W, 'http://rpc', bad)).toEqual({ recipients: [], ok: false })
    let calls = 0
    const good = server((b) => {
      calls++
      return b.method === 'getSignaturesForAddress'
        ? { result: [{ signature: 's1', err: null }] }
        : { result: transfer(W, 'dest') }
    })
    expect(await fetchWalletRecipients(W, 'http://rpc', good)).toEqual({ recipients: ['dest'], ok: true })
    expect(await fetchWalletRecipients(W, 'http://rpc', good)).toEqual({ recipients: ['dest'], ok: true })
    expect(calls).toBe(2)
  })

  it('never sends a JSON-RPC batch (a batch-rejecting server still gives ok:true)', async () => {
    const seen: string[] = []
    const noBatch = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body))
      if (Array.isArray(body))
        return new Response(JSON.stringify({ error: { code: -32600, message: 'batch not allowed' } }), { status: 400 })
      seen.push(body.method)
      if (body.method === 'getSignaturesForAddress') {
        return new Response(JSON.stringify({ result: SIGS(50).slice(0, body.params[1].limit) }))
      }
      // Version 1 must be accepted, or every v1 transaction errors with -32015.
      expect(body.params[1].maxSupportedTransactionVersion).toBe(1)
      return new Response(JSON.stringify({ result: transfer(W, `to-${body.params[0]}`) }))
    }) as unknown as typeof fetch
    const r = await fetchWalletRecipients(W, 'http://rpc', noBatch)
    expect(r.ok).toBe(true)
    expect(r.recipients).toEqual(Array.from({ length: 10 }, (_, i) => `to-s${i}`))
    expect(seen.filter((m) => m === 'getTransaction')).toHaveLength(10)
  })

  it('at most 3 getTransaction calls in flight', async () => {
    let inFlight = 0
    let peak = 0
    const slow = server(async (b) => {
      if (b.method === 'getSignaturesForAddress') return { result: SIGS(10) }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { result: transfer(W, 'x') }
    })
    expect((await fetchWalletRecipients(W, 'http://rpc', slow)).ok).toBe(true)
    expect(peak).toBe(3)
  })

  it('one failed transaction keeps what came back but marks the list partial', async () => {
    const partial = server((b) => {
      if (b.method === 'getSignaturesForAddress') return { result: SIGS(2) }
      return b.params[0] === 's0' ? { result: transfer(W, 'dest') } : { error: { code: -32603, message: 'internal' } }
    })
    expect(await fetchWalletRecipients(W, 'http://rpc', partial)).toEqual({ recipients: ['dest'], ok: false })
  })

  it('a 429 is retried once; an unsupported tx version is skipped, not a failure', async () => {
    let s1 = 0
    const flaky = server((b) => {
      if (b.method === 'getSignaturesForAddress') return { result: SIGS(3) }
      if (b.params[0] === 's1' && s1++ === 0)
        return { status: 429, error: { code: 429, message: 'Too many requests for a specific RPC call' } }
      if (b.params[0] === 's2') return { error: { code: -32015, message: 'Transaction version (2) is not supported' } }
      return { result: transfer(W, `to-${b.params[0]}`) }
    })
    expect(await fetchWalletRecipients(W, 'http://rpc', flaky)).toEqual({ recipients: ['to-s0', 'to-s1'], ok: true })
    expect(s1).toBe(2)
  })

  describe('time budget', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a hanging getTransaction ends the lookup within the 6 s budget as partial', async () => {
      const hang = server((b) => (b.method === 'getSignaturesForAddress' ? { result: SIGS(2) } : new Promise(() => {})))
      let done: unknown = null
      const p = fetchWalletRecipients(W, 'http://rpc', hang).then((r) => (done = r))
      await vi.advanceTimersByTimeAsync(CONTACTS_BUDGET_MS - 100)
      expect(done).toBeNull()
      await vi.advanceTimersByTimeAsync(200)
      await p
      expect(done).toEqual({ recipients: [], ok: false })
    })
  })

  it('partial contacts is said out loud and keeps the decision', () => {
    const v = markContactsPartial({
      decision: 'allow',
      reasons: ['X'],
      explanation: 'No risk signals found for the recipient.',
    })
    expect(v.decision).toBe('allow')
    expect(v.reasons).toContain('CONTACTS_PARTIAL')
    expect(v.explanation).toContain('Lookalike check used local history only (contact list unavailable).')
  })

  it('explanation names both addresses with first/last 4', () => {
    const t = lookalikeExplanation(FAKE, REAL)
    expect(t).toContain('4kxs...xjL5pH1'.slice(0, 4))
    expect(t).toContain(REAL)
    expect(t).toContain('4kxs...5pH1')
  })
})

describe('lookalike through screenRecipient', () => {
  const guard = (look: unknown) =>
    ({
      analyzeProgram: async () => ({ address: 'a', verdict: 'safe', risk_score: 0, explanation: 'Likely a wallet.' }),
      checkLookalike: async () => {
        if (look instanceof Error) throw look
        return look
      },
      getOperator: async () => ({ wallet: 'a', known: false }),
    }) as never

  it('one end only (live shape, weak) -> warning naming the contact, not a block', async () => {
    const live = {
      suspect: false,
      confidence: 'weak',
      findings: [{ original_contact: REAL, prefix_match: 4, suffix_match: 1 }],
    }
    expect(normalizeLookalike(live, FAKE).is_lookalike).toBe(false)
    const v = await screenRecipient(FAKE, guard(live), [REAL])
    expect(v.decision).toBe('warn')
    expect(v.reasons).toContain('LOOKALIKE_PARTIAL')
    expect(v.explanation).toContain(REAL)
  })

  it('finding without match lengths is treated as both ends (strict)', async () => {
    const v = await screenRecipient(FAKE, guard({ suspect: false, findings: [{ original_contact: REAL }] }), [REAL])
    expect(v.decision).toBe('block')
  })

  it('live API shape (weak finding, suspect false, both ends) still blocks and names the contact', async () => {
    const live = {
      suspect: false,
      confidence: 'weak',
      findings: [{ original_contact: REAL, prefix_match: 4, suffix_match: 9 }],
    }
    expect(normalizeLookalike(live, FAKE).is_lookalike).toBe(true)
    const v = await screenRecipient(FAKE, guard(live), [REAL])
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('LOOKALIKE')
    expect(v.explanation).toContain(REAL)
    expect(v.explanation).toContain('4kxs...5pH1')
  })

  it('no findings -> allow; destination is never its own contact', async () => {
    const v = await screenRecipient(REAL, guard({ suspect: false, confidence: 'none', findings: [] }), [REAL])
    expect(v.decision).toBe('allow')
  })

  it('unexpected response shape fails closed with CHECK_FAILED', async () => {
    for (const odd of [{}, { foo: 1 }, null, 'oops']) {
      const v = await screenRecipient(FAKE, guard(odd), [REAL])
      expect(v.decision).toBe('block')
      expect(v.reasons).toContain('CHECK_FAILED')
    }
  })

  it('lookalike 429 says quota, still a block', async () => {
    const e = Object.assign(new Error('SolSentry API 429'), { status: 429 })
    const v = await screenRecipient(FAKE, guard(e), [REAL])
    expect(v.decision).toBe('block')
    expect(v.explanation).toContain('free daily quota')
  })

  it('lookalike API failure fails closed', async () => {
    const v = await screenRecipient(FAKE, guard(new Error('503')), [REAL])
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('CHECK_FAILED')
  })
})
