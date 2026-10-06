export interface HistoryEntry {
  address: string
  decision: 'allow' | 'warn' | 'block'
  explanation: string
  checkedAt: number
}

const MAX_ENTRIES = 100

/** Newest first, one row per address (re-checking replaces the old row). */
export function upsertEntry(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.address !== entry.address)].slice(0, MAX_ENTRIES)
}

