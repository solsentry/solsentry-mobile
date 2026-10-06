import { describe, expect, it } from 'vitest'
import { screenRecipient } from '../src/guard/service'

function fakeGuard(verdict: string, extra: Record<string, unknown> = {}) {
  return {
    analyzeProgram: async () => ({ address: 'a', verdict, risk_score: 0, explanation: 'Likely a wallet.', ...extra }),
    checkLookalike: async () => ({ is_lookalike: false }),
    getOperator: async () => ({ wallet: 'a', known: false, risk_level: 'CLEAN' }),
  } as never
}

describe('recipient that is not a wallet', () => {
  it('mint -> block NOT_A_WALLET', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', { kind: 'mint' }))
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('NOT_A_WALLET')
    expect(v.explanation).toContain('lost')
  })
  it('program -> block', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', { kind: 'program' }))
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('NOT_A_WALLET')
  })
  it('other non-wallet kind -> warn', async () => {
    const v = await screenRecipient('a', fakeGuard('safe', { kind: 'token_account' }))
    expect(v.decision).toBe('warn')
    expect(v.reasons).toContain('NOT_A_WALLET')
  })
  it('wallet stays allow; an existing block is not downgraded', async () => {
    expect((await screenRecipient('a', fakeGuard('safe', { kind: 'wallet' }))).decision).toBe('allow')
    const d = await screenRecipient('a', fakeGuard('dangerous', { kind: 'program', explanation: 'Catalog confirms DRAINER.' }))
    expect(d.decision).toBe('block')
    expect(d.explanation).toContain('DRAINER')
  })
  it('an unknown-verdict mint is upgraded from warn to block', async () => {
    expect((await screenRecipient('a', fakeGuard('unknown', { kind: 'mint' }))).decision).toBe('block')
  })
})
