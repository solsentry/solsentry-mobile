import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildContacts,
  clearWalletContactsCache,
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

const h = (address: string, decision: 'allow' | 'warn' | 'block') => ({ address, decision, explanation: '', checkedAt: 1 })
const transfer = (source: string, destination: string, err: unknown = null) => ({
  meta: { err },
  transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 1 } } }] } },
})

describe('contacts', () => {
  beforeEach(() => clearWalletContactsCache())

  it('history: only allow counts; warn and block do not', () => {
    expect(contactsFromHistory([h('a', 'allow'), h('b', 'block'), h('c', 'warn')])).toEqual(['a'])
  })

  it('parsed txs: only outgoing, successful system transfers', () => {
    const txs = [transfer(W, 'x'), transfer('other', W), transfer(W, 'y', { InstructionError: 1 }), null, transfer(W, 'x')]
    expect(recipientsFromParsedTxs(txs, W)).toEqual(['x', 'x'])
  })

  it('build: dedupe, exclude destination, cap', () => {
    expect(buildContacts('d', [['a', 'd', 'b'], ['a', 'c', '']])).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 80 }, (_, i) => `k${i}`)
    expect(buildContacts('d', [many])).toHaveLength(50)
  })

  it('RPC failure -> [] without throwing; success is cached', async () => {
    const bad = (async () => {
      throw new Error('boom')
    }) as never
    expect(await fetchWalletRecipients(W, 'http://rpc', bad)).toEqual({ recipients: [], ok: false })
    let calls = 0
    const good = (async (_u: string, init: { body: string }) => {
      calls++
      const body = JSON.parse(init.body)
      const result = Array.isArray(body)
        ? body.map((b: { id: number }) => ({ id: b.id, result: transfer(W, 'dest') }))
        : { result: [{ signature: 's1', err: null }] }
      return { ok: true, json: async () => (Array.isArray(body) ? result : result) }
    }) as never
    expect(await fetchWalletRecipients(W, 'http://rpc', good)).toEqual({ recipients: ['dest'], ok: true })
    expect(await fetchWalletRecipients(W, 'http://rpc', good)).toEqual({ recipients: ['dest'], ok: true })
    expect(calls).toBe(2)
  })

  it('a per-item batch error keeps what came back but marks the list partial', async () => {
    clearWalletContactsCache()
    const partial = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body))
      if (!Array.isArray(body)) {
        return new Response(JSON.stringify({ result: [{ signature: 's1', err: null }, { signature: 's2', err: null }] }))
      }
      const tx = { meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: W, destination: 'dest' } } }] } } }
      return new Response(JSON.stringify([{ id: 0, result: tx }, { id: 1, error: { code: 429 } }]))
    }) as unknown as typeof fetch
    expect(await fetchWalletRecipients(W, 'http://rpc', partial)).toEqual({ recipients: ['dest'], ok: false })
  })

  it('partial contacts is said out loud and keeps the decision', () => {
    const v = markContactsPartial({ decision: 'allow', reasons: ['X'], explanation: 'No risk signals found for the recipient.' })
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
    const live = { suspect: false, confidence: 'weak', findings: [{ original_contact: REAL, prefix_match: 4, suffix_match: 1 }] }
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
    const live = { suspect: false, confidence: 'weak', findings: [{ original_contact: REAL, prefix_match: 4, suffix_match: 9 }] }
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
