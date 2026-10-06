import { describe, expect, it } from 'vitest'
import { screenRecipient } from '../src/guard/service'

function fakeGuard(verdict: string, operator: Record<string, unknown> | Error, extra: Record<string, unknown> = {}) {
  return {
    analyzeProgram: async () => ({ address: 'a', verdict, risk_score: 0, explanation: 'Likely a wallet.', ...extra }),
    checkLookalike: async () => ({ is_lookalike: false }),
    getOperator: async () => {
      if (operator instanceof Error) throw operator
      return { wallet: 'a', known: true, ...operator }
    },
  } as never
}

describe('recipient check reads the operator profile', () => {
  it('safe wallet with a CRITICAL operator profile -> block', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', { risk_level: 'CRITICAL', confirmed_rugs: 13 }))
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('OPERATOR_HIGH_RISK')
  })
  it('HIGH level or >= 2 confirmed rugs -> block', async () => {
    expect((await screenRecipient('a', fakeGuard('safe', { risk_level: 'HIGH' }))).decision).toBe('block')
    expect((await screenRecipient('a', fakeGuard('safe', { risk_level: 'UNKNOWN', confirmed_rugs: 2 }))).decision).toBe('block')
  })
  it('MEDIUM or 1 rug -> warn on an otherwise clean recipient', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', { risk_level: 'MEDIUM' }))
    expect(v.decision).toBe('warn')
    expect(v.reasons).toContain('OPERATOR_MEDIUM_RISK')
    expect((await screenRecipient('a', fakeGuard('safe', { confirmed_rugs: 1 }))).decision).toBe('warn')
  })
  it('CLEAN / UNKNOWN / LOW / unknown wallet -> no change', async () => {
    for (const level of ['CLEAN', 'UNKNOWN', 'LOW', undefined]) {
      expect((await screenRecipient('a', fakeGuard('safe', { risk_level: level, confirmed_rugs: 0 }))).decision).toBe('allow')
    }
    expect((await screenRecipient('a', fakeGuard('unknown', { known: false }))).decision).toBe('warn')
  })
  it('a drainer stays blocked and keeps its own explanation', async () => {
    const v = await screenRecipient('a', fakeGuard('dangerous', { risk_level: 'CRITICAL' }, { explanation: 'Catalog confirms this is a DRAINER.' }))
    expect(v.decision).toBe('block')
    expect(v.explanation).toContain('DRAINER')
  })
  it('operator lookup failure fails closed', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', new Error('SolSentry API 503')))
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('CHECK_FAILED')
    expect(v.explanation).toContain('503')
  })
})
