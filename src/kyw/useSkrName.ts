import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'

import { SGT_RPC_URL } from '../config'
import { reverseSkr } from '../seeker/names'

const KEY = 'solsentry-kyw.skr-name.v2'
/** A name can be transferred or expire: read it again after a day; "no name" (or a failed read) after an hour. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_AGE_NONE_MS = 60 * 60 * 1000

interface Cached {
  address: string
  name: string | null
  at: number
}

/** Seeker ID (`name.skr`) of the linked wallet, or null; cached on the phone for a day. */
export function useSkrName(address: string | null): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setName(null)
    if (!address) return
    void (async () => {
      let cached: Cached | null = null
      try {
        cached = JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null') as Cached | null
      } catch {
        cached = null
      }
      if (cached?.address === address) {
        if (live) setName(cached.name)
        if (Date.now() - cached.at < (cached.name ? MAX_AGE_MS : MAX_AGE_NONE_MS)) return
      }
      const fresh = await reverseSkr(address, { fetch: (u, i) => globalThis.fetch(u, i), rpcUrl: SGT_RPC_URL })
      if (!live) return
      setName(fresh)
      await AsyncStorage.setItem(KEY, JSON.stringify({ address, name: fresh, at: Date.now() } satisfies Cached)).catch(() => {})
    })()
    return () => {
      live = false
    }
  }, [address])
  return name
}
