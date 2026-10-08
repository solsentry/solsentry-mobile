import type { RecipientDecision } from '../guard/checks'
import { theme } from './theme'

/** Minimal shape of a guard verdict that the UI depends on. */
export interface VerdictLike {
  decision?: string | null
  explanation?: string | null
  reasons?: string[] | null
}

export interface UiState {
  decision: RecipientDecision
  /** Decision in words (never color-only). */
  label: string
  /** Explanation text from the guard (or a fail-closed reason). */
  message: string
  tone: 'allow' | 'warn' | 'stop'
  /** Icon shown next to the label, so the decision never depends on color alone. */
  icon: 'checkmark-circle' | 'warning' | 'close-circle' | 'cloud-offline'
  color: string
  /** Text and icon color on top of `color` (the label badge). */
  onColor: string
  background: string
  textColor: string
  /** Send button is enabled only when the user can proceed (warn also needs a review). */
  canSend: boolean
  requiresReview: boolean
  /** Shown instead of the send button when blocked. */
  stoppedText: string | null
}

export const STOPPED_TEXT = 'Stopped: nothing was built or signed.'

export function normalizeDecision(d: string | null | undefined): RecipientDecision {
  // Anything that is not an explicit allow/warn is treated as block: fail closed.
  return d === 'allow' || d === 'warn' ? d : 'block'
}

/** Map a guard verdict (or a missing/garbled one) to the UI state. */
export function toUiState(v: VerdictLike | null | undefined): UiState {
  const decision = normalizeDecision(v?.decision)
  const message =
    (v?.explanation && v.explanation.trim()) ||
    (decision === 'block' ? 'The check could not be completed, so nothing was sent.' : '')
  switch (decision) {
    case 'allow':
      return {
        decision, label: 'Allow', message, tone: 'allow', icon: 'checkmark-circle',
        color: theme.allow, onColor: theme.onAllow, background: theme.surface, textColor: theme.text,
        canSend: true, requiresReview: false, stoppedText: null,
      }
    case 'warn':
      return {
        decision, label: 'Warning', message, tone: 'warn', icon: 'warning',
        color: theme.warn, onColor: theme.ink, background: theme.surface, textColor: theme.text,
        canSend: true, requiresReview: true, stoppedText: null,
      }
    default:
      return {
        decision: 'block', label: 'Block', message, tone: 'stop',
        // A check that could not run is still a block, but it is not a finding: different icon.
        icon: v?.decision !== 'block' || v.reasons?.includes('CHECK_FAILED') ? 'cloud-offline' : 'close-circle',
        color: theme.block, onColor: theme.ink, background: theme.block, textColor: theme.ink,
        canSend: false, requiresReview: false, stoppedText: STOPPED_TEXT,
      }
  }
}

/** Can the send button be pressed right now? */
export function sendEnabled(state: UiState, reviewed: boolean, busy: boolean): boolean {
  if (busy || !state.canSend) return false
  return state.requiresReview ? reviewed : true
}
