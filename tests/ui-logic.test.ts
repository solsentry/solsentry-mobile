import { describe, expect, it } from 'vitest'
import { addRecord, countedToday, EMPTY, parsePersisted, parseSettings, utcDayKey, type Persisted } from '../src/kyw/history'
import { earnedNow, multiplier, multiplierText, POINT_RULE, toHalves } from '../src/kyw/points'
import { DEFAULT_SETTINGS, type TaskRecord, type Verdict } from '../src/kyw/types'

let seq = 0
const rec = (at: number, verdict: Verdict = 'accepted'): TaskRecord => ({
  id: `r${seq++}`,
  at,
  short: 'abc…xyz',
  verdict,
  reason: null,
  provider: 'solsentry',
  host: 'h',
  ms: 1,
  bytes: 1,
  signed: true,
})

/** Same steps as engine.ts onResult: the cap reads the signed matches of the UTC day before the record is added. */
function feed(state: Persisted, record: TaskRecord): { state: Persisted; earned: number } {
  let earned = 0
  if (record.verdict === 'accepted') {
    earned = toHalves(earnedNow({ signed: record.signed === true, matchedToday: countedToday(state, record.at) }))
  }
  return { state: addRecord(state, record, earned), earned }
}

describe('earnedNow at the daily cap', () => {
  const cap = POINT_RULE.dailyCap
  it('pays the base below the cap', () => {
    expect(earnedNow({ signed: true, matchedToday: 0 })).toBe(1)
    expect(earnedNow({ signed: true, matchedToday: cap - 1 })).toBe(1)
  })
  it('pays nothing at and above the cap', () => {
    expect(earnedNow({ signed: true, matchedToday: cap })).toBe(0)
    expect(earnedNow({ signed: true, matchedToday: cap + 1 })).toBe(0)
  })
  it('pays nothing for an unsigned result, even at 0', () => {
    expect(earnedNow({ signed: false, matchedToday: 0 })).toBe(0)
  })
})

describe('multiplier and multiplierText', () => {
  it('is 0 for an unverified device whatever else holds', () => {
    expect(multiplier({ deviceVerified: false, genesis: true, independentRpc: true })).toBe(0)
  })
  it('combines genesis and independent RPC (2 * 1.1 float)', () => {
    expect(multiplier({ deviceVerified: true, genesis: false, independentRpc: false })).toBe(1)
    expect(multiplier({ deviceVerified: true, genesis: true, independentRpc: false })).toBe(2)
    expect(multiplier({ deviceVerified: true, genesis: false, independentRpc: true })).toBeCloseTo(1.1, 10)
    const both = multiplier({ deviceVerified: true, genesis: true, independentRpc: true })
    expect(both).toBeCloseTo(2.2, 10)
    expect(multiplierText(both)).toBe('2.2×')
  })
  it('formats 0, 1, 1.1, 2, 2.2', () => {
    expect(multiplierText(0)).toBe('0×')
    expect(multiplierText(1)).toBe('1×')
    expect(multiplierText(1.1)).toBe('1.1×')
    expect(multiplierText(2)).toBe('2×')
    expect(multiplierText(2.2)).toBe('2.2×')
    expect(multiplierText(2 * 1.1)).toBe('2.2×')
  })
})

describe('parseSettings theme', () => {
  it('defaults to dark', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('dark')
    expect(parseSettings(null).theme).toBe('dark')
    expect(parseSettings('not json').theme).toBe('dark')
    expect(parseSettings('{}').theme).toBe('dark')
  })
  it('keeps light and dark, drops anything else', () => {
    expect(parseSettings(JSON.stringify({ theme: 'light' })).theme).toBe('light')
    expect(parseSettings(JSON.stringify({ theme: 'dark' })).theme).toBe('dark')
    expect(parseSettings(JSON.stringify({ theme: 'LIGHT' })).theme).toBe('dark')
    expect(parseSettings(JSON.stringify({ theme: 1 })).theme).toBe('dark')
    expect(parseSettings(JSON.stringify({ theme: null })).theme).toBe('dark')
  })
  it('a bad theme does not reset the other settings', () => {
    const s = parseSettings(JSON.stringify({ theme: 'neon', wifiOnly: true }))
    expect(s.wifiOnly).toBe(true)
    expect(s.theme).toBe('dark')
  })
})

describe('daily cap per UTC day through addRecord', () => {
  const cap = POINT_RULE.dailyCap
  const at = (iso: string) => Date.parse(iso)

  it('201 signed matches the same UTC day: 200 earn, the 201st earns 0', () => {
    const start = at('2026-10-10T09:00:00Z')
    let state = EMPTY
    const earned: number[] = []
    for (let i = 0; i < cap + 1; i++) {
      const r = feed(state, rec(start + i * 1000))
      state = r.state
      earned.push(r.earned)
    }
    expect(state.capDay).toEqual({ day: '2026-10-10', counted: cap + 1 })
    expect(earned.slice(0, cap).every((e) => e === toHalves(1))).toBe(true)
    expect(earned[cap]).toBe(0)
    expect(state.pointHalves).toBe(toHalves(cap))
  })

  it('unsigned matches and other verdicts neither earn nor use up the cap', () => {
    const start = at('2026-10-10T09:00:00Z')
    let state = EMPTY
    for (let i = 0; i < 50; i++) state = feed(state, rec(start + i, i % 2 ? 'diverged' : 'unknown')).state
    const unsigned = feed(state, { ...rec(start + 60), signed: false })
    expect(unsigned.earned).toBe(0)
    expect(countedToday(unsigned.state, start)).toBe(0)
    expect(feed(unsigned.state, rec(start + 100)).earned).toBe(toHalves(1))
  })

  it('a new UTC day starts a fresh cap', () => {
    const before = at('2026-10-10T23:50:00Z')
    let state = EMPTY
    for (let i = 0; i < cap; i++) state = feed(state, rec(before + i * 1000)).state
    expect(feed(state, rec(at('2026-10-10T23:59:59Z'))).earned).toBe(0)
    const first = feed(state, rec(at('2026-10-11T00:00:00Z')))
    expect(first.earned).toBe(toHalves(1))
    expect(first.state.capDay).toEqual({ day: '2026-10-11', counted: 1 })
    expect(utcDayKey(at('2026-10-11T00:00:00Z'))).toBe('2026-10-11')
  })

  it('a record stamped on an earlier day (clock change) does not reset today', () => {
    let state = EMPTY
    for (let i = 0; i < cap; i++) state = feed(state, rec(at('2026-10-11T08:00:00Z') + i)).state
    state = feed(state, rec(at('2026-10-10T23:59:59Z'))).state
    expect(state.capDay).toEqual({ day: '2026-10-11', counted: cap })
    expect(feed(state, rec(at('2026-10-11T09:00:00Z'))).earned).toBe(0)
  })

  it('survives a reopen and drops a malformed cap day', () => {
    const s = feed(EMPTY, rec(at('2026-10-10T09:00:00Z'))).state
    expect(parsePersisted(JSON.stringify(s)).capDay).toEqual({ day: '2026-10-10', counted: 1 })
    expect(parsePersisted(JSON.stringify({ capDay: { day: 'x', counted: 5 } })).capDay).toEqual(EMPTY.capDay)
  })
})
