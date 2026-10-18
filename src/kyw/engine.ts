// Starts and stops validation. With the native service present, the loop runs as a headless task
// inside a foreground service, so it continues in the background and with the screen off. Without
// it (or if it cannot start) the loop runs in the app and the screen is kept awake instead.
import Constants from 'expo-constants'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'

import * as KywService from '@/modules/kyw-service'
import { fetchWithTimeout } from '../net/fetch-timeout'
import { KYW_API_BASE } from './config'
import { getDevice, signWithDevice } from './device-runtime'
import { runLoop, type LoopStatus } from './loop'
import { countedToday } from './history'
import { earnedNow, toHalves } from './points'
import { resolveEndpoint, type ProviderId } from './providers'
import { pacedWait, type CapState } from './pacing'
import { HTTP_TIMEOUT_MS, runOneTask } from './run'
import { fetchServerPoints } from './server-points'
import { getState, load, recordResult, setRunning, setStatus, subscribe, updateSettings } from './store'
import { noteDeviceKind, noteServerPoints } from './widget-runtime'

const KEEP_AWAKE_TAG = 'kyw-validation'
const CLIENT_VERSION = Constants.expoConfig?.version ?? '0'
const API_HOST = KYW_API_BASE.replace(/^https?:\/\//, '').replace(/[:/].*$/, '')

let stopRequested = true
/** What the user last asked for. The service's task may start later than the request. */
let wanted = false
let loopActive = false
let wake: (() => void) | null = null

export type Mode = 'service' | 'in-app'

export function mode(): Mode {
  return KywService.isAvailable() ? 'service' : 'in-app'
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, seconds * 1000)
    function done() {
      clearTimeout(timer)
      wake = null
      resolve()
    }
    wake = done
  })
}

function endpoint() {
  const { settings, secrets } = getState()
  return resolveEndpoint(settings.provider, secrets[settings.provider] ?? '', API_HOST)
}

/** Why the chosen RPC cannot read yet (no URL saved); null when it can. */
export function setupProblem(provider: ProviderId, secrets: Partial<Record<ProviderId, string>>): string | null {
  const e = resolveEndpoint(provider, secrets[provider] ?? '', API_HOST)
  return e.ok ? null : e.problem
}

function onText(): string {
  const { accepted, diverged, unknown } = getState().history.counters
  return `Verification is on · ${accepted} matched · ${diverged} diverged · ${unknown} no result`
}

/** "45 s", "5 min": minutes once the wait is long enough to read as one. */
export function waitText(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`
}

/** SolSentry's cap for this device, read at most once a minute while the loop runs. */
const CAP_READ_EVERY_MS = 60_000

export function statusText(status: LoopStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Verification is off'
    case 'requesting':
      return 'Requesting a task'
    case 'reading':
      return `Verifying ${status.short}`
    case 'waiting':
      if (status.why === 'backoff') return `Waiting ${Math.round(status.seconds)} s before the next try`
      if (status.why === 'capped') return `Today's cap is reached · next task in ${waitText(status.seconds)}`
      if (status.why === 'spread') return `Spread over the day · next task in ${waitText(status.seconds)}`
      return `Next task in ${Math.round(status.seconds)} s`
    case 'stopping':
      return 'Stopping after the current task'
    case 'held':
      if (status.why === 'wifi') return 'Paused: waiting for Wi-Fi'
      if (status.why === 'charging') return 'Paused: waiting for the charger'
      return status.detail ?? 'Paused'
  }
}

/** The loop itself. Returns when validation is stopped. */
async function loop(): Promise<void> {
  if (loopActive) return
  let unsubscribe: (() => void) | null = null
  loopActive = true
  setRunning(true)
  try {
    await load()
    const device = await getDevice()
    noteDeviceKind(device.kind)
    const signDevice = signWithDevice(device)
    const timedFetch = fetchWithTimeout(fetch, HTTP_TIMEOUT_MS, 'Request')
    // Only a hardware key has a server balance; a random id keeps the plain interval.
    let cap: CapState | null = null
    let capReadAt = 0
    const readCap = async (): Promise<CapState | null> => {
      if (device.kind !== 'key') return null
      if (Date.now() - capReadAt < CAP_READ_EVERY_MS) return cap
      capReadAt = Date.now()
      const p = await fetchServerPoints({ fetch: timedFetch, apiBase: KYW_API_BASE }, device.id)
      // A failed read keeps the last known state; none known means no pacing.
      if (p) {
        cap = p.today
        noteServerPoints(p)
      }
      return cap
    }
    let held = false
    // A new pace or spread takes effect now, not after a long wait already started.
    const paceOf = () => `${getState().settings.intervalS}|${getState().settings.spread}`
    let pace = paceOf()
    unsubscribe = subscribe(() => {
      if (paceOf() === pace) return
      pace = paceOf()
      wake?.()
    })
    await runLoop({
      settings: () => getState().settings,
      power: async () => {
        const p = KywService.powerState()
        // Without the native module the conditions cannot be read: do not hold.
        return p ? { wifi: p.wifi, charging: p.charging } : { wifi: true, charging: true }
      },
      ready: async () => {
        const e = endpoint()
        return e.ok ? null : e.problem
      },
      runOne: (onReading) => {
        const e = endpoint()
        if (!e.ok) {
          // The key was removed between the check and the run: an empty turn, then the hold.
          return Promise.resolve({ record: null, retryAfterS: null, backoff: false })
        }
        return runOneTask({
          fetch: timedFetch,
          apiBase: KYW_API_BASE,
          provider: getState().settings.provider,
          endpoint: e,
          clientVersion: CLIENT_VERSION,
          now: Date.now,
          onReading,
          deviceKeyId: device.id,
          signResult: signDevice,
        })
      },
      onResult: async (result) => {
        if (!result.record) return
        let earned = 0
        if (result.record.verdict === 'accepted') {
          const matchedToday = countedToday(getState().history, result.record.at)
          earned = toHalves(earnedNow({ signed: result.record.signed === true, matchedToday }))
        }
        await recordResult(result.record, earned)
        KywService.setText(onText())
      },
      onStatus: (status) => {
        setStatus(stopRequested && status.kind !== 'idle' ? { kind: 'stopping' } : status)
        // The notification follows a hold, so it never says "on" while nothing is read.
        if (status.kind === 'held') {
          KywService.setText(statusText(status))
          held = true
        } else if (held && status.kind !== 'idle') {
          KywService.setText(onText())
          held = false
        }
      },
      sleep,
      stopped: () => stopRequested,
      pace: async (intervalS) => pacedWait(intervalS, await readCap(), Date.now(), getState().settings.spread),
    })
  } finally {
    unsubscribe?.()
    // The service has nothing left to keep alive.
    KywService.stop()
    loopActive = false
    stopRequested = true
    setRunning(false)
    setStatus({ kind: 'idle' })
  }
}

/** Entry point of the headless task started by the foreground service. */
export async function validationTask(): Promise<void> {
  // Switched off between the start request and this task: end the service, run nothing.
  if (!wanted) {
    KywService.stop()
    return
  }
  stopRequested = false
  try {
    await loop()
  } catch {
    // The service must end even if the loop fails.
  }
}

export async function startValidation(): Promise<void> {
  wanted = true
  // Remembered so the next app start turns it on again (an update or a reboot stops the service).
  if (!getState().settings.keepOn) void updateSettings({ keepOn: true }).catch(() => {})
  // Nothing to read with: the home screen says what to set up, and saving it starts verification.
  const { settings, secrets } = getState()
  if (setupProblem(settings.provider, secrets)) return
  if (loopActive) return
  stopRequested = false
  if (mode() === 'service') {
    try {
      // No loop is running here (checked above), so ask for a fresh task even if a service from a
      // previous run is still up.
      KywService.start('Verification is on', true)
      setRunning(true)
      return
    } catch {
      // Fall through: run in the app with the screen kept on.
    }
  }
  void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
  void loop().finally(() => {
    void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
  })
}

export function stopValidation(): void {
  wanted = false
  if (getState().settings.keepOn) void updateSettings({ keepOn: false }).catch(() => {})
  stopRequested = true
  wake?.()
  // If the task never started (service refused), make sure nothing is left behind.
  if (!loopActive) {
    KywService.stop()
    setRunning(false)
    setStatus({ kind: 'idle' })
  } else {
    setStatus({ kind: 'stopping' })
  }
}
