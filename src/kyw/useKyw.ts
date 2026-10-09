import { useEffect, useSyncExternalStore } from 'react'

import { getState, load, subscribe, type KywState } from './store'

export function useKyw(): KywState {
  useEffect(() => {
    void load()
  }, [])
  return useSyncExternalStore(subscribe, getState, getState)
}
