// How long to wait after a good turn, given SolSentry's cap for this device. Results past the cap earn
// nothing, so once SolSentry says the cap is reached the phone slows down instead of spending battery
// and data; with the window's reset time it can also space tasks so the cap lasts the whole window.

/** Wait between tasks once the cap is reached and the reset time is not known. */
export const AFTER_CAP_S = 300
/** Longest single wait: the loop wakes at least this often to read SolSentry again. */
export const MAX_WAIT_S = 1800

export interface CapState {
  counted: number
  cap: number | null
  /** Epoch ms when the cap window ends; null when SolSentry did not say. */
  resetsAt: number | null
}

export type Paced = { seconds: number; why: 'interval' | 'capped' | 'spread' }

export function pacedWait(intervalS: number, cap: CapState | null, now: number, spread: boolean): Paced {
  const base: Paced = { seconds: intervalS, why: 'interval' }
  if (!cap || cap.cap === null) return base
  const left = cap.resetsAt !== null && cap.resetsAt > now ? (cap.resetsAt - now) / 1000 : null
  if (cap.counted >= cap.cap) {
    // Past the cap: sleep to the reset when it is known (plus a minute of slack), else a slow pulse.
    const seconds = left !== null ? Math.min(left + 60, MAX_WAIT_S) : AFTER_CAP_S
    return { seconds: Math.max(seconds, intervalS), why: 'capped' }
  }
  if (spread && left !== null) {
    const even = left / (cap.cap - cap.counted)
    if (even > intervalS) return { seconds: Math.min(even, MAX_WAIT_S), why: 'spread' }
  }
  return base
}
