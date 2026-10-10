import type { UnknownReason } from '../kyw-core'
import type { ProviderId } from './providers'

export type Verdict = 'accepted' | 'diverged' | 'unknown'

/** One finished validation, as kept on the phone. Only part of the signature is stored. */
export interface TaskRecord {
  id: string
  at: number
  /** e.g. `4kx…pH1`; empty when no task was received. */
  short: string
  verdict: Verdict
  /** Why the verdict is unknown (from the read or from the server). null otherwise. */
  reason: string | null
  provider: ProviderId
  host: string
  ms: number
  bytes: number
}

export interface Settings {
  provider: ProviderId
  saveKey: boolean
  wifiOnly: boolean
  chargingOnly: boolean
  /** Pause between two tasks, in seconds. */
  intervalS: number
  /** Look of the app; the validation ignores it. */
  theme: 'dark' | 'light'
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'solsentry',
  saveKey: false,
  wifiOnly: false,
  chargingOnly: false,
  intervalS: 5,
  theme: 'dark',
}

export const INTERVAL_CHOICES_S = [2, 5, 15, 60] as const

export interface Counters {
  accepted: number
  diverged: number
  unknown: number
}

export type LocalReason = UnknownReason | 'submit_failed' | 'unsupported_task' | 'server_unreachable' | 'server_busy'
