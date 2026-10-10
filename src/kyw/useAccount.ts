// Screen state for the linked wallet and the install identity (account.ts holds the logic).
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'

import { fetchWithTimeout } from '../guard/fetch-timeout'

import { pointsStatus, type LinkedWallet } from './account'
import { forgetLinkedWallet, linkWalletNow, loadLinkedWallet } from './account-runtime'
import { KYW_API_BASE } from './config'
import { ACCOUNT_TEXT as T } from './copy'
import type { DeviceIdentity } from './device'
import { getDevice } from './device-runtime'
import { fetchServerPoints, type ServerPoints } from './server-points'

/** How often an open screen re-reads the server balance. */
const SERVER_POINTS_EVERY_MS = 60_000

export function useAccount() {
  const [device, setDevice] = useState<DeviceIdentity | null>(null)
  const [wallet, setWallet] = useState<LinkedWallet | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [server, setServer] = useState<ServerPoints | null>(null)
  const [focused, setFocused] = useState(false)

  // Re-read on focus: the wallet can be linked or unlinked on another screen.
  useFocusEffect(
    useCallback(() => {
      let live = true
      void getDevice().then((d) => live && setDevice(d))
      void loadLinkedWallet().then((w) => live && setWallet(w))
      setFocused(true)
      return () => {
        live = false
        setFocused(false)
      }
    }, []),
  )

  // Only a hardware key signs results, so only its id can have a server balance.
  const keyId = device?.kind === 'key' ? device.id : null
  useEffect(() => {
    if (!focused || !keyId) return
    let live = true
    const deps = { fetch: fetchWithTimeout(fetch, 10_000, 'Request'), apiBase: KYW_API_BASE }
    const read = () => void fetchServerPoints(deps, keyId).then((p) => live && p && setServer(p))
    read()
    const timer = setInterval(read, SERVER_POINTS_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [focused, keyId])

  const link = async () => {
    if (busy) return
    setBusy(true)
    setNote(null)
    const r = await linkWalletNow()
    setBusy(false)
    if (r.ok) setWallet(r.wallet)
    else {
      const text = { cancelled: T.cancelled, timeout: T.timedOut, bad_signature: T.badSignature, failed: T.failed }
      setNote(text[r.reason])
      if (r.reason === 'failed' && r.detail) console.warn('wallet link failed:', r.detail)
    }
  }

  const unlink = async () => {
    await forgetLinkedWallet()
    setWallet(null)
  }

  const status = device ? pointsStatus({ deviceCheck: device.check, deviceKind: device.kind, wallet }) : null
  return { device, wallet, busy, note, link, unlink, status, server }
}
