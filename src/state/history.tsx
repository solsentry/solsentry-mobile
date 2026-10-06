import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { upsertEntry, type HistoryEntry } from './history-logic'
export type { HistoryEntry } from './history-logic'

const KEY = 'solsentry-guard-mobile/history/v1'

interface HistoryApi {
  entries: HistoryEntry[]
  record: (entry: HistoryEntry) => void
  clear: () => void
}

const Ctx = createContext<HistoryApi>({ entries: [], record: () => {}, clear: () => {} })

export function HistoryProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setEntries(parsed)
      })
      .catch(() => {})
  }, [])

  const persist = (next: HistoryEntry[]) => {
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
  }

  const record = useCallback((entry: HistoryEntry) => {
    setEntries((prev) => {
      const next = upsertEntry(prev, entry)
      persist(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setEntries([])
    persist([])
  }, [])

  const value = useMemo(() => ({ entries, record, clear }), [entries, record, clear])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useHistory(): HistoryApi {
  return useContext(Ctx)
}
