import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resultSentence, TEXT, VERDICT_LABEL } from '../src/kyw/copy'
import { MAX_RECORDS, EMPTY, addRecord, parsePersisted, parseSettings, tasksPerHour } from '../src/kyw/history'
import { BACKOFF_MAX_S, HOLD_RECHECK_S, nextBackoff, runLoop, type LoopStatus, type TurnResult } from '../src/kyw/loop'
import { runSelfTest, type SelfTestVector } from '../src/kyw/selftest/run'
import { DEFAULT_SETTINGS, type Settings, type TaskRecord } from '../src/kyw/types'

const record = (i: number, verdict: TaskRecord['verdict'] = 'accepted'): TaskRecord => ({
  id: `t${i}`,
  at: 1000 * i,
  short: 'abc…xyz',
  verdict,
  reason: verdict === 'unknown' ? 'rpc_error' : null,
  provider: 'solsentry',
  host: 'api.solsentry.app',
  ms: 100,
  bytes: 2000,
})

const turn = (backoff: boolean, retryAfterS: number | null = null): TurnResult => ({ record: record(1), backoff, retryAfterS })

function harness(turns: TurnResult[], settings: Partial<Settings> = {}, power = { wifi: true, charging: true }) {
  const sleeps: number[] = []
  const statuses: LoopStatus[] = []
  let ran = 0
  let stop = false
  const done = runLoop({
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    power: async () => power,
    ready: async () => null,
    runOne: async () => turns[ran++],
    onResult: () => {
      if (ran >= turns.length) stop = true
    },
    onStatus: (s) => statuses.push(s),
    sleep: async (s) => {
      sleeps.push(s)
      if (sleeps.length > 50) stop = true
    },
    stopped: () => stop,
  })
  return { done, sleeps, statuses, ran: () => ran }
}

describe('validation loop', () => {
  it('pauses for the chosen interval between tasks', async () => {
    const h = harness([turn(false), turn(false), turn(false)], { intervalS: 15 })
    await h.done
    expect(h.sleeps).toEqual([15, 15])
    expect(h.statuses.at(-1)).toEqual({ kind: 'idle' })
  })

  it('waits longer after each push-back and returns to the interval after a clean task', async () => {
    const h = harness([turn(true), turn(true), turn(true, 90), turn(false), turn(true), turn(false)], { intervalS: 2 })
    await h.done
    expect(h.sleeps).toEqual([5, 10, 90, 2, 5])
  })

  it('never waits past the cap by itself', () => {
    let s = 0
    for (let i = 0; i < 20; i++) s = nextBackoff(s)
    expect(s).toBe(BACKOFF_MAX_S)
  })

  it('holds without asking for a task while a condition is not met', async () => {
    const h = harness([turn(false)], { wifiOnly: true }, { wifi: false, charging: true })
    await h.done
    expect(h.ran()).toBe(0)
    expect(h.sleeps.every((s) => s === HOLD_RECHECK_S)).toBe(true)
    expect(h.statuses[0]).toEqual({ kind: 'held', why: 'wifi' })
    const c = harness([turn(false)], { chargingOnly: true }, { wifi: true, charging: false })
    await c.done
    expect(c.statuses[0]).toEqual({ kind: 'held', why: 'charging' })
  })
})

describe('history on the phone', () => {
  it('counts every task and keeps only the last records', () => {
    let s = EMPTY
    for (let i = 0; i < MAX_RECORDS + 10; i++) s = addRecord(s, record(i, i % 3 === 0 ? 'unknown' : 'accepted'))
    expect(s.records).toHaveLength(MAX_RECORDS)
    expect(s.records[0].id).toBe('t10')
    expect(s.counters.accepted + s.counters.unknown).toBe(MAX_RECORDS + 10)
  })

  it('survives a close and reopen (serialise, parse)', () => {
    const s = addRecord(addRecord(EMPTY, record(1)), record(2, 'diverged'))
    expect(parsePersisted(JSON.stringify(s))).toEqual(s)
    expect(parseSettings(JSON.stringify({ ...DEFAULT_SETTINGS, provider: 'helius', saveKey: true, intervalS: 60 }))).toEqual({
      ...DEFAULT_SETTINGS,
      provider: 'helius',
      saveKey: true,
      intervalS: 60,
    })
  })

  it('drops unreadable data instead of throwing', () => {
    expect(parsePersisted('{oops')).toEqual(EMPTY)
    expect(parsePersisted(JSON.stringify({ records: [{ id: 1 }, record(3)], counters: { accepted: -4, diverged: 'x' } }))).toEqual({
      records: [record(3)],
      counters: { accepted: 0, diverged: 0, unknown: 0 },
    })
    expect(parseSettings('[]')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(JSON.stringify({ provider: 'evil', intervalS: 0.001 }))).toEqual(DEFAULT_SETTINGS)
  })

  it('measures the recent pace only once there is enough to measure', () => {
    const records = Array.from({ length: 61 }, (_, i) => ({ ...record(i), at: i * 10_000 }))
    expect(tasksPerHour(records, 600_000)).toBe(360)
    expect(tasksPerHour(records.slice(0, 9), 600_000)).toBeNull()
    expect(tasksPerHour(records.slice(0, 11), 600_000)).toBeNull() // 10 tasks but only 100 s
  })
})

describe('wording', () => {
  const all = [
    ...Object.values(TEXT),
    ...Object.values(VERDICT_LABEL),
    ...['accepted', 'diverged'].map((v) => resultSentence({ verdict: v as 'accepted', reason: null })),
    ...[
      'not_available', 'rpc_error', 'rate_limited', 'version', 'timeout', 'invalid_response', 'submit_failed',
      'unsupported_task', 'no_task', 'expired', 'unknown_task', 'already_answered', 'wrong_spec_version', 'wrong_fact_type', 'x',
    ].map((reason) => resultSentence({ verdict: 'unknown', reason })),
  ].join('\n')

  it('says exactly what an accepted result means', () => {
    expect(resultSentence({ verdict: 'accepted', reason: null })).toBe("Matched SolSentry's reference read.")
  })

  it('never uses mining words or claims beyond the comparison', () => {
    expect(all).not.toMatch(/\bmin(e|es|ed|er|ers|ing)\b/i)
    expect(all).not.toMatch(/verified (wallet|device)|\bcorrect\b|independent sources|proof of work|\bPoW\b|reward|\bearn(s|ing)?\b(?! in this version)/i)
    expect(all).not.toMatch(/\d\s?%|accuracy/i)
  })
})

describe('self-test bundle', () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../src/kyw/selftest/vectors.json'), 'utf8')) as SelfTestVector[]
  const dir = join(__dirname, 'fixtures', 'kyw_tx_core')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { vectors: Record<string, unknown>[] }

  it('carries the same vectors as the fixtures (regenerate with tools/gen_selftest_vectors.mjs)', () => {
    expect(vectors).toHaveLength(manifest.vectors.length)
    manifest.vectors.forEach((m, i) => {
      const v = vectors[i]
      expect(v.raw).toBe(readFileSync(join(dir, m.file as string), 'utf8'))
      expect({ name: v.name, raw_sha256: v.raw_sha256, status: v.status, unknown_reason: v.unknown_reason, fact_digest: v.fact_digest, failed: v.failed }).toEqual({
        name: m.name, raw_sha256: m.raw_sha256, status: m.status, unknown_reason: m.unknown_reason, fact_digest: m.fact_digest, failed: m.failed,
      })
    })
  })

  it('passes all vectors and reports a failure when one is tampered with', () => {
    expect(runSelfTest(vectors)).toMatchObject({ total: 44, passed: 44, failures: [] })
    const tampered = vectors.map((v, i) => (i === 7 ? { ...v, raw: v.raw.replace(/"fee":\d+/, '"fee":1') } : v))
    expect(runSelfTest(tampered).failures).toEqual([vectors[7].name])
  })
})
