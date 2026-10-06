import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, screenSender } from '../src/guard/service'

const guard = {
  analyzeProgram: async () => ({ address: 'a', verdict: 'safe', risk_score: 0, flags: null, kind: 'wallet' }),
  checkLookalike: async () => ({ is_lookalike: false }),
  getOperator: async () => ({ wallet: 'a', known: false, risk_level: 'UNKNOWN' }),
} as never

describe('RPC timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a never-resolving fetch becomes a Block after 10 s', async () => {
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch
    const p = screenSender('a', guard, { fetch: fetchWithTimeout(hang) })
    await vi.advanceTimersByTimeAsync(10_001)
    const v = await p
    expect(v.decision).toBe('block')
    expect(v.explanation).toContain('timed out')
  })

  it('passes an abort signal to the underlying fetch and clears the timer on success', async () => {
    let signal: AbortSignal | undefined
    const ok = (async (_u: unknown, i?: RequestInit) => {
      signal = i?.signal ?? undefined
      return new Response('{}')
    }) as unknown as typeof fetch
    const r = await fetchWithTimeout(ok)('https://x', {})
    expect(r.ok).toBe(true)
    expect(signal).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
