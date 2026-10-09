// The validation loop: one task at a time, a pause between tasks, a longer wait when the network,
// the server or the RPC pushes back, and a hold while a user condition (Wi-Fi, charging) is not met.
import type { RunResult } from './run'
import type { Settings } from './types'

/** A turn may end without a record when the RPC setup changed under it. */
export type TurnResult = RunResult | { record: null; retryAfterS: null; backoff: false }

export const BACKOFF_START_S = 5
export const BACKOFF_MAX_S = 120
export const HOLD_RECHECK_S = 15

export type LoopStatus =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'reading'; short: string }
  | { kind: 'waiting'; seconds: number; why: 'interval' | 'backoff' }
  | { kind: 'held'; why: 'wifi' | 'charging' | 'setup'; detail?: string }

export interface PowerState {
  wifi: boolean
  charging: boolean
}

export interface LoopDeps {
  settings: () => Settings
  power: () => Promise<PowerState>
  /** null: the chosen RPC is not usable yet (missing key); the string says why. */
  ready: () => Promise<string | null>
  runOne: (onReading: (short: string) => void) => Promise<TurnResult>
  onResult: (result: TurnResult) => Promise<void> | void
  onStatus: (status: LoopStatus) => void
  /** Resolves after `seconds`, or earlier when the loop is stopped. */
  sleep: (seconds: number) => Promise<void>
  stopped: () => boolean
}

/** Next wait after a push-back: doubles from BACKOFF_START_S up to BACKOFF_MAX_S. */
export function nextBackoff(previous: number): number {
  return previous <= 0 ? BACKOFF_START_S : Math.min(previous * 2, BACKOFF_MAX_S)
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  let backoff = 0
  while (!deps.stopped()) {
    const settings = deps.settings()
    if (settings.wifiOnly || settings.chargingOnly) {
      const power = await deps.power()
      const why = settings.wifiOnly && !power.wifi ? 'wifi' : settings.chargingOnly && !power.charging ? 'charging' : null
      if (why) {
        deps.onStatus({ kind: 'held', why })
        await deps.sleep(HOLD_RECHECK_S)
        continue
      }
    }
    const problem = await deps.ready()
    if (problem) {
      deps.onStatus({ kind: 'held', why: 'setup', detail: problem })
      await deps.sleep(HOLD_RECHECK_S)
      continue
    }

    deps.onStatus({ kind: 'requesting' })
    const result = await deps.runOne((short) => deps.onStatus({ kind: 'reading', short }))
    await deps.onResult(result)
    if (deps.stopped()) break

    let seconds = Math.max(settings.intervalS, 0.6)
    let why: 'interval' | 'backoff' = 'interval'
    if (result.backoff) {
      backoff = nextBackoff(backoff)
      seconds = Math.max(seconds, backoff, result.retryAfterS ?? 0)
      why = 'backoff'
    } else {
      backoff = 0
    }
    deps.onStatus({ kind: 'waiting', seconds, why })
    await deps.sleep(seconds)
  }
  deps.onStatus({ kind: 'idle' })
}
