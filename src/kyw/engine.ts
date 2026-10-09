// Starts and stops validation. With the native service present, the loop runs as a headless task
// inside a foreground service, so it continues in the background and with the screen off. Without
// it (or if it cannot start) the loop runs in the app and the screen is kept awake instead.
import Constants from 'expo-constants'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'

import * as KywService from '@/modules/kyw-service'
import { fetchWithTimeout } from '../guard/fetch-timeout'
import { KYW_API_BASE } from './config'
import { runLoop, type LoopStatus } from './loop'
import { resolveEndpoint } from './providers'
import { HTTP_TIMEOUT_MS, runOneTask } from './run'
import { getState, load, recordResult, setRunning, setStatus } from './store'

const KEEP_AWAKE_TAG = 'kyw-validation'
const CLIENT_VERSION = Constants.expoConfig?.version ?? '0'
const API_HOST = KYW_API_BASE.replace(/^https?:\/\//, '').replace(/[:/].*$/, '')

let stopRequested = true
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

export function statusText(status: LoopStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Validation is off'
    case 'requesting':
      return 'Requesting a task'
    case 'reading':
      return `Verifying ${status.short}`
    case 'waiting':
      return status.why === 'backoff'
        ? `Waiting ${Math.round(status.seconds)} s before the next try`
        : `Next task in ${Math.round(status.seconds)} s`
    case 'held':
      if (status.why === 'wifi') return 'Paused: waiting for Wi-Fi'
      if (status.why === 'charging') return 'Paused: waiting for the charger'
      return status.detail ?? 'Paused'
  }
}

/** The loop itself. Returns when validation is stopped. */
async function loop(): Promise<void> {
  if (loopActive) return
  loopActive = true
  setRunning(true)
  try {
    await load()
    const timedFetch = fetchWithTimeout(fetch, HTTP_TIMEOUT_MS, 'Request')
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
        })
      },
      onResult: async (result) => {
        if (!result.record) return
        await recordResult(result.record)
        const { accepted, diverged, unknown } = getState().history.counters
        KywService.setText(`Validation is on · ${accepted} matched · ${diverged} diverged · ${unknown} no result`)
      },
      onStatus: setStatus,
      sleep,
      stopped: () => stopRequested,
    })
  } finally {
    loopActive = false
    stopRequested = true
    setRunning(false)
    setStatus({ kind: 'idle' })
  }
}

/** Entry point of the headless task started by the foreground service. */
export async function validationTask(): Promise<void> {
  stopRequested = false
  try {
    await loop()
  } catch {
    // The service must end even if the loop fails.
  }
}

export async function startValidation(): Promise<void> {
  if (loopActive) return
  stopRequested = false
  if (mode() === 'service') {
    try {
      KywService.start('Validation is on')
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
  stopRequested = true
  wake?.()
  // If the task never started (service refused), make sure nothing is left behind.
  if (!loopActive) {
    KywService.stop()
    setRunning(false)
    setStatus({ kind: 'idle' })
  }
}
