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
  /** The result went out with the device signature (only signed results count points). */
  signed?: boolean
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
  /** Wallet whose "no Genesis Token" notice the user closed; the notice comes back for another one. */
  seenNoGenesis: string | null
  /** Version of the how-it-works steps last read or skipped; a newer INTRO_VERSION shows them again. */
  introSeen: number
  /** Space tasks so today's cap lasts until SolSentry's window resets (needs the server's reset time). */
  spread: boolean
  /** Verification was on when the app last ran: opening the app turns it on again (after an update or a reboot). */
  keepOn: boolean
  /** The one-time "add the widget" card was shown (after the first claim or the first daily cap). */
  widgetOffered: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'solsentry',
  saveKey: false,
  wifiOnly: false,
  chargingOnly: false,
  intervalS: 5,
  theme: 'dark',
  seenNoGenesis: null,
  introSeen: 0,
  spread: false,
  keepOn: false,
  widgetOffered: false,
}

/** Bump to show the how-it-works steps once more after an update. */
export const INTRO_VERSION = 3

export const INTERVAL_CHOICES_S = [2, 5, 15, 60] as const

export interface Counters {
  accepted: number
  diverged: number
  unknown: number
}

export type LocalReason = UnknownReason | 'submit_failed' | 'unsupported_task' | 'server_unreachable' | 'server_busy'
