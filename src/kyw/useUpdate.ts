import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { useCallback, useEffect, useState } from 'react'
import { Linking } from 'react-native'

import { fetchWithTimeout } from '../net/fetch-timeout'
import { LATEST_URL, parseLatest, updateToOffer, type LatestBuild } from './update'

const DISMISSED_KEY = 'kyw:update-dismissed'

/** This build's versionCode, as app.json set it at build time; null when the config does not say. */
function installedVersionCode(): number | null {
  const code = Constants.expoConfig?.android?.versionCode
  return typeof code === 'number' && Number.isInteger(code) ? code : null
}

/** Checks once per Home mount for a newer build. Any failure leaves the notice hidden. */
export function useUpdate(): { offer: LatestBuild | null; download: () => void; later: () => void } {
  const [offer, setOffer] = useState<LatestBuild | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(DISMISSED_KEY).catch(() => null)
        const dismissed = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
        const res = await fetchWithTimeout(fetch, 8_000, 'Update check')(LATEST_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!res.ok) return
        const next = updateToOffer(installedVersionCode(), parseLatest(await res.json()), dismissed)
        if (alive) setOffer(next)
      } catch {
        // No notice: the check is a convenience.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const download = useCallback(() => {
    if (offer) void Linking.openURL(offer.url).catch(() => undefined)
  }, [offer])

  const later = useCallback(() => {
    if (offer) void AsyncStorage.setItem(DISMISSED_KEY, String(offer.versionCode)).catch(() => undefined)
    setOffer(null)
  }, [offer])

  return { offer, download, later }
}
