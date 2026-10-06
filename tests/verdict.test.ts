import { describe, expect, it } from 'vitest'
import { STOPPED_TEXT, normalizeDecision, sendEnabled, toUiState } from '../src/ui/verdict'
import { checkRecipient } from '../src/guard/checks'
import { upsertEntry, type HistoryEntry } from '../src/state/history-logic'
import { parseSolToLamports } from '../src/wallet/mwa-math'

describe('verdict -> UI state', () => {
  it('allow: send enabled, no review needed', () => {
    const s = toUiState({ decision: 'allow', explanation: 'No risk signals found for the recipient.' })
    expect(s.label).toBe('Allow')
    expect(s.canSend).toBe(true)
    expect(s.requiresReview).toBe(false)
    expect(sendEnabled(s, false, false)).toBe(true)
    expect(s.stoppedText).toBeNull()
  })

  it('warn: send only after the explicit review switch', () => {
    const s = toUiState({ decision: 'warn', explanation: 'Warning: unverified' })
    expect(s.label).toBe('Warning')
    expect(s.requiresReview).toBe(true)
    expect(sendEnabled(s, false, false)).toBe(false)
    expect(sendEnabled(s, true, false)).toBe(true)
    expect(sendEnabled(s, true, true)).toBe(false) // busy
  })

  it('block: send disabled even if "reviewed" is on, with the stopped text', () => {
    const s = toUiState({ decision: 'block', explanation: 'Blocked: known drainer' })
    expect(s.label).toBe('Block')
    expect(sendEnabled(s, true, false)).toBe(false)
    expect(s.stoppedText).toBe(STOPPED_TEXT)
    expect(s.stoppedText).toBe('Stopped: nothing was built or signed.')
  })

  it('error / missing / garbled verdict is treated as block (fail closed)', () => {
    for (const v of [null, undefined, {}, { decision: 'safe' }, { decision: '' }, { decision: undefined }]) {
      const s = toUiState(v as never)
      expect(s.decision).toBe('block')
      expect(sendEnabled(s, true, false)).toBe(false)
    }
    expect(normalizeDecision('ALLOW')).toBe('block')
  })
})

describe('vendored checkRecipient is fail-closed by default', () => {
  const failing = {
    analyzeProgram: async () => {
      throw new Error('Network error: offline')
    },
    checkLookalike: async () => {
      throw new Error('unused')
    },
  }
  it('API error -> block with the reason, mapped to the stopped UI', async () => {
    const v = await checkRecipient('11111111111111111111111111111112', {}, failing as never)
    expect(v.decision).toBe('block')
    expect(v.reasons).toContain('CHECK_FAILED')
    expect(v.explanation).toContain('offline')
    expect(toUiState(v).stoppedText).toBe(STOPPED_TEXT)
  })

  const analysis = (verdict: string, extra: object = {}) => ({
    analyzeProgram: async () => ({ address: 'x', kind: 'wallet', known_label: null, known_category: null, risk_score: 0, verdict, flags: [], authorities: {}, extensions: {}, explanation: '', fetched_at: 0, ...extra }),
    checkLookalike: async () => ({ destination: 'x', is_lookalike: false, findings: [] }),
  })
  it('unknown -> warn, safe -> allow, dangerous -> block', async () => {
    expect((await checkRecipient('a', {}, analysis('unknown') as never)).decision).toBe('warn')
    expect((await checkRecipient('a', {}, analysis('safe') as never)).decision).toBe('allow')
    expect((await checkRecipient('a', {}, analysis('dangerous') as never)).decision).toBe('block')
    expect((await checkRecipient('a', {}, analysis('safe', { known_category: 'drainer' }) as never)).decision).toBe('block')
  })
})

describe('history', () => {
  const e = (address: string, checkedAt: number): HistoryEntry => ({ address, decision: 'allow', explanation: '', checkedAt })
  it('re-check replaces the old row and moves it to the top', () => {
    const list = upsertEntry(upsertEntry([], e('A', 1)), e('B', 2))
    const next = upsertEntry(list, e('A', 3))
    expect(next.map((x) => x.address)).toEqual(['A', 'B'])
    expect(next[0].checkedAt).toBe(3)
  })
})

describe('SOL amount parsing', () => {
  it('parses exactly', () => {
    expect(parseSolToLamports('1')).toBe(1_000_000_000n)
    expect(parseSolToLamports('0.000000001')).toBe(1n)
    expect(parseSolToLamports(' 0.05 ')).toBe(50_000_000n)
  })
  it('rejects bad input', () => {
    for (const bad of ['', '0', '-1', '1e3', '0.0000000001', 'abc', '1.']) expect(() => parseSolToLamports(bad)).toThrow()
  })
})
