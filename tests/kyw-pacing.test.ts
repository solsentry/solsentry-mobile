import { describe, expect, it } from 'vitest'
import { runLoop, type LoopStatus } from '../src/kyw/loop'
import { AFTER_CAP_S, MAX_WAIT_S, pacedWait } from '../src/kyw/pacing'
import { DEFAULT_SETTINGS } from '../src/kyw/types'

const NOW = 1_760_000_000_000

describe('wait after a good task', () => {
  it('keeps the interval without a cap or without SolSentry', () => {
    expect(pacedWait(5, null, NOW, true)).toEqual({ seconds: 5, why: 'interval' })
    expect(pacedWait(5, { counted: 999, cap: null, resetsAt: null }, NOW, true)).toEqual({ seconds: 5, why: 'interval' })
  })
  it('keeps the interval under the cap when the reset time is unknown or spreading is off', () => {
    expect(pacedWait(5, { counted: 10, cap: 200, resetsAt: null }, NOW, true).why).toBe('interval')
    expect(pacedWait(5, { counted: 10, cap: 200, resetsAt: NOW + 3_600_000 }, NOW, false).why).toBe('interval')
  })
  it('slows to a pulse past the cap when the reset time is unknown', () => {
    expect(pacedWait(5, { counted: 200, cap: 200, resetsAt: null }, NOW, false)).toEqual({ seconds: AFTER_CAP_S, why: 'capped' })
  })
  it('sleeps to the reset past the cap, a minute late, never longer than the max wait', () => {
    expect(pacedWait(5, { counted: 200, cap: 200, resetsAt: NOW + 600_000 }, NOW, false)).toEqual({ seconds: 660, why: 'capped' })
    expect(pacedWait(5, { counted: 200, cap: 200, resetsAt: NOW + 86_400_000 }, NOW, false).seconds).toBe(MAX_WAIT_S)
  })
  it('spreads what is left of the cap over what is left of the window', () => {
    // 100 results left, 10 000 s left: one every 100 s.
    expect(pacedWait(5, { counted: 100, cap: 200, resetsAt: NOW + 10_000_000 }, NOW, true)).toEqual({ seconds: 100, why: 'spread' })
  })
  it('never runs faster than the user interval', () => {
    expect(pacedWait(60, { counted: 0, cap: 200, resetsAt: NOW + 1_000_000 }, NOW, true)).toEqual({ seconds: 60, why: 'interval' })
    expect(pacedWait(60, { counted: 200, cap: 200, resetsAt: NOW + 1_000 }, NOW, true).seconds).toBe(61)
  })
  it('ignores a reset time already past', () => {
    expect(pacedWait(5, { counted: 200, cap: 200, resetsAt: NOW - 1 }, NOW, true)).toEqual({ seconds: AFTER_CAP_S, why: 'capped' })
  })
})

describe('the loop with a pace', () => {
  it('waits what pace says after a good turn and says why', async () => {
    const statuses: LoopStatus[] = []
    const slept: number[] = []
    let turns = 0
    await runLoop({
      settings: () => DEFAULT_SETTINGS,
      power: async () => ({ wifi: true, charging: true }),
      ready: async () => null,
      runOne: async () => {
        turns++
        return { record: null, retryAfterS: null, backoff: false }
      },
      onResult: () => {},
      onStatus: (s) => statuses.push(s),
      sleep: async (s) => {
        slept.push(s)
      },
      stopped: () => turns >= 2,
      pace: async () => ({ seconds: 300, why: 'capped' }),
    })
    expect(slept).toEqual([300])
    expect(statuses).toContainEqual({ kind: 'waiting', seconds: 300, why: 'capped' })
  })
  it('does not sleep when stopped while pace was reading', async () => {
    let stop = false
    const slept: number[] = []
    await runLoop({
      settings: () => DEFAULT_SETTINGS,
      power: async () => ({ wifi: true, charging: true }),
      ready: async () => null,
      runOne: async () => ({ record: null, retryAfterS: null, backoff: false }),
      onResult: () => {},
      onStatus: () => {},
      sleep: async (s) => {
        slept.push(s)
      },
      stopped: () => stop,
      pace: async () => {
        stop = true
        return { seconds: 1800, why: 'capped' }
      },
    })
    expect(slept).toEqual([])
  })
})
