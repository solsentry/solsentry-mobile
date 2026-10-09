// Pure state for what the phone keeps: the last records (for the grid) and lifetime counters.
import { DEFAULT_SETTINGS, INTERVAL_CHOICES_S, type Counters, type Settings, type TaskRecord } from './types'
import { PROVIDERS } from './providers'

export const MAX_RECORDS = 364

export interface Persisted {
  records: TaskRecord[]
  counters: Counters
}

export const EMPTY: Persisted = { records: [], counters: { accepted: 0, diverged: 0, unknown: 0 } }

export function addRecord(state: Persisted, record: TaskRecord): Persisted {
  const records = [...state.records, record]
  return {
    records: records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records,
    counters: { ...state.counters, [record.verdict]: state.counters[record.verdict] + 1 },
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
    typeof x.bytes === 'number'
  )
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

/** Read stored history. Anything unreadable is dropped; it never throws. */
export function parsePersisted(raw: string | null): Persisted {
  if (!raw) return EMPTY
  try {
    const v = JSON.parse(raw) as { records?: unknown; counters?: Record<string, unknown> }
    const records = Array.isArray(v.records) ? v.records.filter(isRecord).slice(-MAX_RECORDS) : []
    const c = v.counters ?? {}
    return { records, counters: { accepted: count(c.accepted), diverged: count(c.diverged), unknown: count(c.unknown) } }
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
