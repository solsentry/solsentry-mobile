// Screen text of the Approvals tab, in one place.
import { CANCELLED_REVOKE } from '../ui/errors'
import type { Delegation } from './delegations'

export const APPROVALS_TEXT = {
  tab: 'Approvals',
  header: 'Who can move your tokens',
  subheader: 'Token accounts in this wallet that another address is allowed to spend from.',
  unlimited: 'Unlimited',
  fullBalance: 'Full balance',
  revoke: 'Revoke',
  success: 'Approval revoked. Confirmed on-chain.',
  cancelled: CANCELLED_REVOKE,
  unconfirmed: 'Could not confirm the revoke yet. Refresh the list before trying again.',
  empty: 'No active token approvals found for this wallet.',
  footnote:
    'Covers SPL token delegates only. Does not cover mint-level permanent delegates or the app connections in your wallet settings.',
  error: 'Could not read your token accounts. Nothing was checked. Try again.',
  frozen: 'Frozen, cannot revoke',
  notConnected: 'Connect your wallet to see its token approvals.',
} as const

export function shortAddress(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}

export function confirmText(d: Pick<Delegation, 'delegate' | 'mint'>): string {
  return `Revoke this approval? ${shortAddress(d.delegate)} will no longer be able to move ${shortAddress(d.mint)} from this account. A network fee applies.`
}

/** Badge for the row, or null when the delegated amount itself is shown. */
export function kindLabel(d: Pick<Delegation, 'kind'>): string | null {
  return d.kind === 'UNLIMITED' ? APPROVALS_TEXT.unlimited : d.kind === 'FULL_BALANCE' ? APPROVALS_TEXT.fullBalance : null
}

/** Tab bar entry: `null` removes the tab (expo-router), `undefined` keeps the default link. */
export function approvalsTabHref(enabled: boolean): null | undefined {
  return enabled ? undefined : null
}
