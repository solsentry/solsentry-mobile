// Pure state for what the phone keeps: the last records (for the grid), lifetime counters and the
// number of matched results per day for the last DAYS_KEPT days.
import { DEFAULT_SETTINGS, INTERVAL_CHOICES_S, type Counters, type Settings, type TaskRecord } from './types'
import { PROVIDERS } from './providers'

export const MAX_RECORDS = 364

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

export const DAYS_KEPT = 28

export interface Persisted {
  records: TaskRecord[]
  counters: Counters
  /** Matched results per local day, keyed `YYYY-MM-DD`. Only the last DAYS_KEPT days are kept. */
  days: Record<string, number>
  /** Estimated points, in halves (see points.ts). */
  pointHalves: number
  /** Matched, signed results of one UTC day: the server counts its daily cap per UTC day. */
  capDay: { day: string; counted: number }
  /** Point rule the estimate was counted under; a stored estimate from another rule starts again at 0. */
  rule: number
}

/** Rule rev. 2 (10/10/2026). Bump when the way points are counted changes. */
export const POINT_RULE_VERSION = 2

export const EMPTY: Persisted = {
  records: [],
  counters: { accepted: 0, diverged: 0, unknown: 0 },
  days: {},
  pointHalves: 0,
  capDay: { day: '', counted: 0 },
  rule: POINT_RULE_VERSION,
}

/** UTC calendar day of a timestamp, `YYYY-MM-DD`. */
export const utcDayKey = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** One more signed match on its UTC day; a record stamped before the day in hand (clock change) leaves it alone. */
function nextCapDay(state: Persisted, record: TaskRecord): Persisted['capDay'] {
  if (record.verdict !== 'accepted' || record.signed !== true) return state.capDay
  const day = utcDayKey(record.at)
  if (day < state.capDay.day) return state.capDay
  return { day, counted: countedToday(state, record.at) + 1 }
}

/** Matched, signed results already counted on the UTC day of `at`. */
export function countedToday(state: Persisted, at: number): number {
  return state.capDay.day === utcDayKey(at) ? state.capDay.counted : 0
}

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function pruneDays(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days).filter((k) => DAY_KEY.test(k)).sort()
  const out: Record<string, number> = {}
  for (const k of keys.slice(-DAYS_KEPT)) out[k] = days[k]
  return out
}

/** The last DAYS_KEPT local days ending at `now`, oldest first, with the matched count of each. */
export function lastDays(days: Record<string, number>, now: number): { key: string; date: Date; matched: number }[] {
  const out: { key: string; date: Date; matched: number }[] = []
  const today = new Date(now)
  for (let i = DAYS_KEPT - 1; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = dayKey(date.getTime())
    out.push({ key, date, matched: days[key] ?? 0 })
  }
  return out
}

/** 0 for an empty day, then quartiles of the busiest day in view. */
export function dayLevel(matched: number, max: number): number {
  if (matched <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((matched / max) * 4)))
}

/** Consecutive days with at least one matched result, ending today (or yesterday if today has none yet). */
export function dayStreak(days: Record<string, number>, now: number): number {
  const list = lastDays(days, now).reverse()
  let i = list[0].matched > 0 ? 0 : 1
  let n = 0
  for (; i < list.length && list[i].matched > 0; i++) n++
  return n
}

/** `earnedHalves` is what a matched result is worth (points.ts); other verdicts never add points. */
export function addRecord(state: Persisted, record: TaskRecord, earnedHalves = 0): Persisted {
  const records = [...state.records, record]
  const key = dayKey(record.at)
  const days = record.verdict === 'accepted' ? pruneDays({ ...state.days, [key]: (state.days[key] ?? 0) + 1 }) : state.days
  return {
    records: records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records,
    counters: { ...state.counters, [record.verdict]: state.counters[record.verdict] + 1 },
    days,
    pointHalves: state.pointHalves + (record.verdict === 'accepted' ? count(earnedHalves) : 0),
    capDay: nextCapDay(state, record),
    rule: state.rule,
  }
}

function isRecord(r: unknown): r is TaskRecord {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    typeof x.at === 'number' &&
    typeof x.short === 'string' &&
    (x.verdict === 'accepted' || x.verdict === 'diverged' || x.verdict === 'unknown') &&
    (x.reason === null || (typeof x.reason === 'string' && /^[a-z_]{1,40}$/.test(x.reason) && x.reason !== '__proto__')) &&
    typeof x.host === 'string' &&
    typeof x.ms === 'number' &&
    typeof x.bytes === 'number' &&
    (x.signed === undefined || typeof x.signed === 'boolean')
  )
}


function parseCapDay(v: unknown): Persisted['capDay'] {
  if (typeof v !== 'object' || v === null) return EMPTY.capDay
  const c = v as { day?: unknown; counted?: unknown }
  return typeof c.day === 'string' && DAY_KEY.test(c.day) ? { day: c.day, counted: count(c.counted) } : EMPTY.capDay
}

/** Read stored history. Anything unreadable is dropped; it never throws. */
export function parsePersisted(raw: string | null): Persisted {
  if (!raw) return EMPTY
  try {
    const v = JSON.parse(raw) as { records?: unknown; counters?: Record<string, unknown>; days?: unknown }
    const records = Array.isArray(v.records) ? v.records.filter(isRecord).slice(-MAX_RECORDS) : []
    const c = v.counters ?? {}
    const days: Record<string, number> = {}
    if (typeof v.days === 'object' && v.days !== null && !Array.isArray(v.days)) {
      for (const [k, n] of Object.entries(v.days as Record<string, unknown>)) if (DAY_KEY.test(k)) days[k] = count(n)
    }
    return {
      records,
      counters: { accepted: count(c.accepted), diverged: count(c.diverged), unknown: count(c.unknown) },
      days: pruneDays(days),
      ...(v as { rule?: unknown }).rule === POINT_RULE_VERSION
        ? { pointHalves: count((v as { pointHalves?: unknown }).pointHalves), capDay: parseCapDay((v as { capDay?: unknown }).capDay) }
        : { pointHalves: 0, capDay: EMPTY.capDay },
      rule: POINT_RULE_VERSION,
    }
  } catch {
    return EMPTY
  }
}

export function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULT_SETTINGS
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    return {
      provider: PROVIDERS.some((p) => p.id === v.provider) ? (v.provider as Settings['provider']) : DEFAULT_SETTINGS.provider,
      saveKey: v.saveKey === true,
      wifiOnly: v.wifiOnly === true,
      chargingOnly: v.chargingOnly === true,
      intervalS: (INTERVAL_CHOICES_S as readonly number[]).includes(v.intervalS as number)
        ? (v.intervalS as number)
        : DEFAULT_SETTINGS.intervalS,
      theme: v.theme === 'light' ? 'light' : 'dark',
      seenNoGenesis: typeof v.seenNoGenesis === 'string' && v.seenNoGenesis.length <= 64 ? v.seenNoGenesis : null,
      seenIntro: v.seenIntro === true,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Pace over the last `windowMs`: tasks per hour between the first and the last record in the window.
 * null until there are at least 10 tasks spread over 2 minutes, so a short burst is not shown as a rate.
 */
export function tasksPerHour(records: TaskRecord[], now: number, windowMs = 60 * 60 * 1000): number | null {
  const recent = records.filter((r) => now - r.at <= windowMs)
  if (recent.length < 10) return null
  const span = recent[recent.length - 1].at - recent[0].at
  return span >= 120_000 ? Math.round(((recent.length - 1) * 3_600_000) / span) : null
}
