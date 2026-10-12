// Screen state for the linked wallet and the install identity (account.ts holds the logic).
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchWithTimeout } from '../net/fetch-timeout'

import { pointsStatus, type LinkedWallet } from './account'
import { forgetLinkedWallet, linkWalletNow, loadLinkedWallet, unlinkWalletNow } from './account-runtime'
import type { ClaimOutcome } from './claim-flow'
import { claimNow } from './claim-runtime'
import { KYW_API_BASE } from './config'
import { ACCOUNT_TEXT as T } from './copy'
import type { DeviceIdentity } from './device'
import { getDevice } from './device-runtime'
import { fetchServerPoints, type ServerPoints } from './server-points'
import { useKyw } from './useKyw'
import { noteDeviceKind, noteServerPoints } from './widget-runtime'

/** How often an open screen re-reads the server balance. */
const SERVER_POINTS_EVERY_MS = 60_000
/** A new matched result re-reads it sooner, but not more often than this. */
const SERVER_POINTS_MIN_GAP_MS = 10_000

export function useAccount() {
  const [device, setDevice] = useState<DeviceIdentity | null>(null)
  const [wallet, setWallet] = useState<LinkedWallet | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [server, setServer] = useState<ServerPoints | null>(null)
  const [focused, setFocused] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [claim, setClaim] = useState<ClaimOutcome | null>(null)

  // Re-read on focus: the wallet can be linked or unlinked on another screen.
  useFocusEffect(
    useCallback(() => {
      let live = true
      void getDevice().then((d) => {
        noteDeviceKind(d.kind)
        if (live) setDevice(d)
      })
      void loadLinkedWallet().then((w) => live && setWallet(w))
      setFocused(true)
      return () => {
        live = false
        setFocused(false)
      }
    }, []),
  )

  // A claim result belongs to the wallet it paid: another wallet linked (here or on another screen) clears it.
  const claimWallet = useRef<string | null>(null)
  useEffect(() => {
    const address = wallet?.address ?? null
    if (claimWallet.current !== address) setClaim(null)
    claimWallet.current = address
  }, [wallet?.address])

  // Only a hardware key signs results, so only its id can have a server balance.
  const keyId = device?.kind === 'key' ? device.id : null
  const readServer = useRef<(() => void) | null>(null)
  const lastRead = useRef(0)
  /** When the request behind `server` started: an answer older than a link says nothing about it. */
  const readStarted = useRef(0)
  useEffect(() => {
    if (!focused || !keyId) return
    let live = true
    const deps = { fetch: fetchWithTimeout(fetch, 10_000, 'Request'), apiBase: KYW_API_BASE }
    const read = () => {
      const started = Date.now()
      lastRead.current = started
      void fetchServerPoints(deps, keyId).then((p) => {
        if (p) noteServerPoints(p)
        if (!live || !p) return
        readStarted.current = started
        setServer(p)
      })
    }
    readServer.current = read
    read()
    const timer = setInterval(read, SERVER_POINTS_EVERY_MS)
    return () => {
      live = false
      readServer.current = null
      clearInterval(timer)
    }
  }, [focused, keyId])

  // The server is the record of the link: one it no longer holds (unlinked, or replaced) is dropped here.
  useEffect(() => {
    if (!server || !wallet || readStarted.current <= wallet.linkedAt) return
    if (server.wallet === null || server.wallet.linkId !== wallet.linkId) {
      void forgetLinkedWallet()
      setWallet(null)
    }
  }, [server, wallet])

  // While validating, the balance follows the matched results instead of jumping once a minute.
  const accepted = useKyw().history.counters.accepted
  useEffect(() => {
    if (Date.now() - lastRead.current >= SERVER_POINTS_MIN_GAP_MS) readServer.current?.()
  }, [accepted])

  const link = async () => {
    if (busy) return
    setBusy(true)
    setNote(null)
    const r = await linkWalletNow()
    setBusy(false)
    if (r.ok) setWallet(r.wallet)
    else {
      const text = {
        cancelled: T.cancelled,
        timeout: T.timedOut,
        bad_signature: T.badSignature,
        failed: T.failed,
        server: T.linkRefused,
        no_device_key: T.noDeviceKey,
      }
      setNote(text[r.reason])
      if (r.detail) console.warn('wallet link failed:', r.reason, r.detail)
    }
    readServer.current?.()
  }

  const unlink = async () => {
    if (!wallet || busy) return
    setBusy(true)
    setNote(null)
    const ok = await unlinkWalletNow(wallet)
    setBusy(false)
    if (ok) {
      setWallet(null)
      setClaim(null)
      readServer.current?.()
    } else setNote(T.unlinkFailed)
  }

  const claimSkr = async () => {
    if (!wallet || claiming) return
    setClaiming(true)
    setClaim(null)
    const out = await claimNow(wallet).catch((e): ClaimOutcome => ({ kind: 'error', detail: String(e).slice(0, 200) }))
    setClaiming(false)
    setClaim(out)
    if (out.kind === 'error' || out.kind === 'refused') console.warn('claim:', out.kind, 'detail' in out ? out.detail : out.why)
    readServer.current?.()
  }

  const status = device ? pointsStatus({ deviceCheck: device.check, deviceKind: device.kind, wallet }) : null
  /** A new claim starts with no result on screen (the sheet opens on Approve, not on the last receipt). */
  const resetClaim = () => setClaim(null)
  return { device, wallet, busy, note, link, unlink, status, server, claiming, claim, claimSkr, resetClaim }
}
