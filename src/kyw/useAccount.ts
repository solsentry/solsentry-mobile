// Screen state for the linked wallet and the install identity (account.ts holds the logic).
import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'

import { pointsStatus, type LinkedWallet } from './account'
import { forgetLinkedWallet, linkWalletNow, loadLinkedWallet } from './account-runtime'
import { ACCOUNT_TEXT as T } from './copy'
import type { DeviceIdentity } from './device'
import { getDevice } from './device-runtime'

export function useAccount() {
  const [device, setDevice] = useState<DeviceIdentity | null>(null)
  const [wallet, setWallet] = useState<LinkedWallet | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Re-read on focus: the wallet can be linked or unlinked on another screen.
  useFocusEffect(
    useCallback(() => {
      let live = true
      void getDevice().then((d) => live && setDevice(d))
      void loadLinkedWallet().then((w) => live && setWallet(w))
      return () => {
        live = false
      }
    }, []),
  )

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
  return { device, wallet, busy, note, link, unlink, status }
}
