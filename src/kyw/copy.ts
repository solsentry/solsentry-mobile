// Every string the validation screens show. Kept in one file so the wording can be reviewed and
// tested: "verify" and "validate" only, and an accepted result says what was compared, no more.
import brand from '../../brand.json'
import type { Capability, ProbeReport } from './probe'
import type { TaskRecord, Verdict } from './types'

export const TEXT = {
  deviceTitle: 'This device',
  whenTitle: 'When to verify',
  themeTitle: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light',
  appName: brand.appName,
  tagline: 'Verify public Solana transactions on your phone.',
  toggle: 'Verification',
  on: 'On',
  off: 'Off',
  explain:
    'Each task is one public Solana transaction. Your phone reads it from the RPC you choose, recomputes its facts and sends a digest. SolSentry compares the digest with its own reference read. This is data verification, not Solana consensus. Matched, signed results count points, and points turn into SKR paid from a public pool.',
  gridTitle: 'Recent tasks',
  daysTitle: 'Last 28 days',
  daysUnit: 'matched results',
  today: 'Today',
  streak: (n: number) => `${n} days in a row with a matched result.`,
  gridEmpty: 'Turn verification on to fill these rows. One dot is one task.',
  latest: 'Selected task',
  rpcTitle: 'RPC for the read',
  probeButton: 'Test this RPC',
  probeStale: 'Out of date, test again',
  rpcNote:
    'Your key stays on this phone. It is sent only to the RPC provider you chose. SolSentry receives the provider host name, never the key.',
  saveKey: 'Save my key',
  saveKeyOn: 'Stored encrypted on this phone (Android Keystore).',
  saveKeyOff: 'Kept only until you close the app.',
  beta: 'beta',
  settings: 'Settings',
  background: 'Background',
  backgroundService:
    'Verification keeps running in the background and with the screen off. Android shows a notification while it runs.',
  backgroundInApp: 'This build verifies only while the app is open. The screen stays on while verification runs.',
  battery: 'Battery optimization',
  batteryExempt: 'Not restricted: Android will not pause verification to save battery.',
  batteryRestricted: 'Android may pause verification when the phone is idle. Allow unrestricted battery use to avoid that.',
  batteryButton: 'Allow unrestricted battery use',
  wifiOnly: 'Only on Wi-Fi',
  chargingOnly: 'Only while charging',
  interval: 'Pause between tasks',
  clear: 'Clear history on this phone',
  about:
    'A matched result means your phone and SolSentry computed the same digest for the same public transaction. It says nothing about any wallet, token or person.',
} as const

export const PROBE_LABELS = {
  C1: 'Recent transactions',
  C2: 'Old transactions',
  C3: 'Address history (first page)',
  C4: 'Old address history',
  C5: 'Account state',
  C6: 'Safe pace',
} as const

export const PROBE_REASONS: Record<NonNullable<Capability['reason']>, string> = {
  rpc_error: 'network or RPC error',
  http_error: 'HTTP error',
  timeout: 'request timed out',
  not_available: 'no data returned',
  empty_page: 'empty page',
  invalid_response: 'unusable response',
  rate_limited: 'rate limited',
  version: 'transaction version unsupported',
}

export function probeCapabilityText(capability: Capability): string {
  if (capability.class === 'full') return 'full'
  if (capability.class === 'limited') return `limited (${capability.page_size ?? 0} entries per page)`
  const reason = capability.reason ?? (capability.class === 'rate_limited' || capability.class === 'version'
    ? capability.class : 'not_available')
  return `not available (${PROBE_REASONS[reason]})`
}

export function probePaceText(intervalMs: number | null): string {
  return intervalMs === null ? PROBE_REASONS.rate_limited : `1 request every ${intervalMs} ms`
}

export function probeReportLines(report: ProbeReport): string[] {
  return (Object.keys(PROBE_LABELS) as (keyof typeof PROBE_LABELS)[]).map((id) =>
    `${PROBE_LABELS[id]}: ${id === 'C6'
      ? probePaceText(report.capabilities.C6.min_interval_ms)
      : probeCapabilityText(report.capabilities[id])}`,
  )
}

export function probeTestedText(measuredAt: string): string {
  return `Tested ${new Date(measuredAt).toLocaleString('en-US')}`
}

export function probeProblemText(problem: string): string {
  if (problem === 'no_targets') return 'RPC test targets are not available.'
  if (problem === 'network') return 'Could not load RPC test targets. Try again.'
  if (/^http_\d+$/.test(problem)) return `Could not load RPC test targets (HTTP ${problem.slice(5)}).`
  // resolveEndpoint supplies fixed, user-facing problems without echoing the input.
  return problem
}

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
  server_unreachable: 'Could not reach SolSentry for a task. Your RPC was not used. The next try waits longer.',
  server_busy: 'SolSentry asked the app to slow down. The next try waits longer.',
  expired: 'The task expired before the result arrived.',
  unknown_task: 'SolSentry did not recognise the task.',
  already_answered: 'This task was already answered.',
  wrong_spec_version: 'This app version uses another version of the fact rules.',
  wrong_fact_type: 'This app version does not compute this kind of fact.',
}

export const ACCOUNT_TEXT = {
  title: 'Points',
  balance: 'Balance',
  walletTitle: 'Wallet',
  planned: 'Planned',
  pointsLabel: 'points',
  pointsUnknown: '—',
  pendingNote:
    'Points are held for this install only. Link a wallet to keep them and to claim SKR (one with a Seeker Genesis Token is Genesis). Uninstalling or clearing the app loses them.',
  skrUnit: 'SKR',
  skrTitle: 'SKR balance',
  skrServer: 'SKR SolSentry owes your linked wallet, from the signed results of this phone. Paid from a public pool.',
  skrServerLater: 'SKR SolSentry owes your linked wallet, from the signed results of this phone. Earned now, paid out after the hackathon.',
  skrRate: '1 SKR per 40 matched results.',
  skrWindow: (earned: string, cap: string) => `${earned}/${cap} SKR today`,
  skrPoints: (points: string) => `${points} points`,
  skrSoon: 'Points turn into SKR from a public pool. The SKR balance shows here once SolSentry turns it on.',
  claim: 'Claim SKR',
  claiming: 'Waiting for the wallet…',
  laterNeedsWallet: 'Link a wallet to receive SKR. SKR accrues only to a linked wallet.',
  claimNeedsWallet: 'Link a wallet to claim SKR. SKR accrues only to a linked wallet.',
  claimMin: (min: string) => `You can claim from ${min} SKR.`,
  claimOpen: 'A claim is open. Claim again to finish it.',
  claimFee: 'Your wallet pays the network fee. The first claim also opens its SKR account, so keep ~0.003 SOL in it.',
  poolEmpty: 'Pool empty, refills soon.',
  needsSol: (sol: string) => `Needs ~${sol} SOL for network fees. Add SOL to the linked wallet and claim again.`,
  claimExpired: 'The transaction expired before it landed. Try again.',
  claimCancelled: 'Claim cancelled in the wallet. Nothing was sent.',
  claimWrongWallet: 'The wallet that opened is not the linked one. Switch to the linked wallet and try again.',
  claimRefused: 'SolSentry sent a transaction this app does not accept. Nothing was signed.',
  claimBelowMin: 'Below the minimum claim.',
  claimNotLinked: 'SolSentry has no wallet linked to this phone. Link it again.',
  claimFailed: 'The claim did not go through. Try again.',
  claimPaid: (amount: string) => `${amount} SKR sent to your wallet.`,
  claimSent: (amount: string) => `${amount} SKR sent. SolSentry is still confirming it.`,
  viewTx: 'View on Solscan',
  pointsSoon: 'Estimate kept on this phone. The balance that counts is the one SolSentry computes from your signed results.',
  pointsServer: 'Balance from SolSentry, computed from the signed results of this phone.',
  pointsLocal: (estimate: string) => `Estimate kept on this phone: ${estimate} points.`,
  rateTitle: 'Multipliers',
  rateGenesis: 'Wallet with a Seeker Genesis Token',
  rateRpc: 'Your own RPC, tested with every capability full',
  rateNow: (cap: number) => `Today each matched, signed result counts 1 point, up to ${cap} a day.`,
  ratePlanned: 'Multipliers are planned and not counted yet.',
  rateZero: 'This phone has no hardware key, so its results are not signed and do not count points.',
  today: (n: number, cap: number) => `${Math.min(n, cap)}/${cap} today`,
  link: 'Link wallet',
  connectTitle: 'Your Seeker wallet',
  connect: 'Connect wallet',
  connectNote: 'Opens the wallet on this phone and asks you to sign one message. No transaction, nothing to pay.',
  badgeGenesis: 'Genesis',
  badgeDevice: 'Verified device',
  linking: 'Waiting for the wallet…',
  linked: 'Linked wallet',
  unlink: 'Unlink wallet',
  unlinkFailed: 'Could not reach SolSentry to unlink. Try again.',
  linkRefused: 'SolSentry did not accept the link. Nothing was linked. Try again.',
  noDeviceKey: 'This phone has no hardware key, so it cannot sign a wallet link.',
  genesis: 'Genesis: this wallet holds a Seeker Genesis Token.',
  noGenesis: 'No Seeker Genesis Token on this wallet.',
  genesisUnknown: 'Could not check the Seeker Genesis Token right now.',
  synced: 'Linked on SolSentry.',
  cancelled: 'Linking was cancelled in the wallet.',
  badSignature: 'The wallet signature did not check out. Nothing was linked.',
  failed: 'Could not open the wallet.',
  timedOut: 'The wallet was not answered in time. Tap Connect wallet to try again.',
  redeemTitle: 'Redeem',
  redeemNote: 'Planned. Nothing can be redeemed yet and points have no set value.',
  redeemNoteSkr: 'Planned: more ways to use points besides SKR.',
  redeemItems: ['SolSentry access', 'RPC credits', 'Events'],
  rpcMenuTitle: 'RPC for the read',
}

/** Home screen blocks. */
export const HOME_TEXT = {
  statusOn: 'Verifying',
  claimCta: 'Claim',
  creditToast: 'MATCHED RESULTS',
  statusOff: 'Paused',
  pace: (n: number) => `${n} tasks/h`,
  pointsUnit: 'pts',
  pointsCta: 'Points and rate',
  rate: 'Multiplier',
  rateDevice: 'Verified phone',
  rateGenesis: 'Genesis',
  rateRpc: 'Own RPC',
  tasks: 'Recent tasks',
  walletOpen: 'Wallet and points',
  close: 'Close',
  themeLight: 'Switch to light theme',
  themeDark: 'Switch to dark theme',
}

/** Settings: what the install identity is and what the hardware check said. */
export function deviceLines(d: { id: string; kind: 'key' | 'random'; check: string; headline: string | null } | null): string[] {
  if (!d) return ['Checking this device…']
  const lines: string[] = []
  if (d.kind === 'key') {
    lines.push(d.headline ?? (d.check === 'not_checked' ? 'Hardware key in place; not checked by SolSentry yet.' : 'Could not verify this device.'))
    lines.push('Results are signed with a key that never leaves this phone.')
  } else {
    lines.push('No hardware key on this phone: results are not signed.')
  }
  // The start of every P-256 public key is the same DER header: show the end, which differs per install.
  lines.push(`Install ID: …${d.id.slice(-10)}`)
  lines.push('A new install gets a new ID. No wallet, serial or phone number is used.')
  return lines
}

/** Which RPC the reads use right now (A: always visible on the status card). */
export function readingViaText(providerLabel: string): string {
  return `Reading via ${providerLabel}.`
}

/** B: asked before switching the RPC while validation runs. */
export function switchProviderPrompt(
  providerLabel: string,
  usesKey: boolean,
): { title: string; body: string; confirm: string; cancel: string } {
  return {
    title: `Switch to ${providerLabel}?`,
    body: usesKey
      ? `The next reads will go to ${providerLabel}, with the key saved for it.`
      : `The next reads will go through ${providerLabel}.`,
    confirm: 'Switch',
    cancel: 'Keep current',
  }
}

/** One sentence for a finished task. */
export function resultSentence(record: Pick<TaskRecord, 'verdict' | 'reason'>): string {
  if (record.verdict === 'accepted') return "Matched SolSentry's reference read."
  if (record.verdict === 'diverged') return "Did not match SolSentry's reference read. The result was recorded."
  const reason = record.reason ?? ''
  // Own keys only: a stored reason such as "__proto__" must not reach the prototype.
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason] : 'No result for this task.'
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`
}
