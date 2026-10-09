// Every string the validation screens show. Kept in one file so the wording can be reviewed and
// tested: "verify" and "validate" only, and an accepted result says what was compared, no more.
import type { TaskRecord, Verdict } from './types'

export const TEXT = {
  appName: 'SolSentry KYW',
  tagline: 'Verify public Solana transactions on your phone.',
  toggle: 'Validation',
  on: 'On',
  off: 'Off',
  explain:
    'Each task is one public Solana transaction. Your phone reads it from the RPC you choose, recomputes its facts and sends a digest. SolSentry compares the digest with its own reference read. Nothing is paid or earned in this version.',
  gridTitle: 'Recent tasks',
  gridEmpty: 'Turn validation on to fill this grid. One square is one task.',
  latest: 'Selected task',
  rpcTitle: 'RPC for the read',
  rpcNote:
    'Your key stays on this phone. It is sent only to the RPC provider you chose. SolSentry receives the provider host name, never the key.',
  saveKey: 'Save my key',
  saveKeyOn: 'Stored encrypted on this phone (Android Keystore).',
  saveKeyOff: 'Kept only until you close the app.',
  beta: 'beta',
  settings: 'Settings',
  background: 'Background',
  backgroundService:
    'Validation keeps running in the background and with the screen off. Android shows a notification while it runs.',
  backgroundInApp: 'This build validates only while the app is open. The screen stays on while validation runs.',
  battery: 'Battery optimization',
  batteryExempt: 'Not restricted: Android will not pause validation to save battery.',
  batteryRestricted: 'Android may pause validation when the phone is idle. Allow unrestricted battery use to avoid that.',
  batteryButton: 'Allow unrestricted battery use',
  wifiOnly: 'Only on Wi-Fi',
  chargingOnly: 'Only while charging',
  interval: 'Pause between tasks',
  clear: 'Clear history on this phone',
  about:
    'A matched result means your phone and SolSentry computed the same digest for the same public transaction. It says nothing about any wallet, token or person.',
} as const

export const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: 'Matched',
  diverged: 'Diverged',
  unknown: 'No result',
}

const REASON_TEXT: Record<string, string> = {
  not_available: 'The RPC did not return this transaction.',
  rpc_error: 'The read failed (network or RPC error).',
  rate_limited: 'The RPC limited the request rate. The next try waits longer.',
  version: 'The RPC refused the transaction version.',
  timeout: 'The read took longer than 10 s.',
  invalid_response: 'The RPC response could not be used.',
  submit_failed: 'The result could not be sent to SolSentry.',
  key_rejected: 'The RPC provider refused your key. Check the key below.',
  unsupported_task: 'This app version cannot do the task it received.',
  no_task: 'No task available right now.',
  expired: 'The task expired before the result arrived.',
  unknown_task: 'SolSentry did not recognise the task.',
  already_answered: 'This task was already answered.',
  wrong_spec_version: 'This app version uses another version of the fact rules.',
  wrong_fact_type: 'This app version does not compute this kind of fact.',
}

/** One sentence for a finished task. */
export function resultSentence(record: Pick<TaskRecord, 'verdict' | 'reason'>): string {
  if (record.verdict === 'accepted') return "Matched SolSentry's reference read."
  if (record.verdict === 'diverged') return "Did not match SolSentry's reference read. The result was recorded."
  return REASON_TEXT[record.reason ?? ''] ?? 'No result for this task.'
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`
}
