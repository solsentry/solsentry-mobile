// ADR 0010 amendment e1: pure policy verification only.
// Root/network/time come from the caller, never from the untrusted history.
import { requireValue } from './codec'
import type { TablePin } from './verifier'
import {
  TIME,
  base64url,
  canonical,
  digest,
  fields,
  keyDirectory,
  list,
  object,
  safeInteger,
  signatureValid,
  strictJson,
  type JsonRecord,
} from './policy-wire'

export interface EpochPolicyNetwork {
  cluster: string
  genesisHash: string
  shredVersion: number
  slotsPerEpoch: number
  firstNormalEpoch: number
  firstNormalSlot: number
}
export interface EpochPolicyTrust {
  rootPublicKey: Uint8Array
  network: Readonly<EpochPolicyNetwork>
}
export type PolicyStep =
  | 'directory'
  | 'signer'
  | 'schema'
  | 'delegation'
  | 'equivocation'
  | 'chain'
  | 'reauthorized'
  | 'not_yet'
  | 'expired'
  | 'network'
export type EpochPolicyVerdict = { result: 'refused'; step: PolicyStep } | { result: 'ok'; pins: [number, string][] }
export interface AcceptedEpochPolicy {
  readonly rev: number
  readonly manifestSha256: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly network: Readonly<EpochPolicyNetwork>
  readonly tablePins: readonly Readonly<TablePin>[]
  readonly revoked: readonly Readonly<{ epoch: number; sha256: string }>[]
}
export type EpochPolicyVerification =
  | { verdict: { result: 'refused'; step: PolicyStep }; accepted?: never }
  | { verdict: { result: 'ok'; pins: [number, string][] }; accepted: AcceptedEpochPolicy }

const FIELDS = [
  'v',
  'rev',
  'previousManifestSha256',
  'issuedAt',
  'expiresAt',
  'network',
  'tables',
  'revocations',
  'reason',
]
const NETWORK = [
  'cluster',
  'genesisHash',
  'shredVersion',
  'slotsPerEpoch',
  'firstNormalEpoch',
  'firstNormalSlot',
] as const
const TABLE = ['tableSha256', 'tableBytes', 'bankSlot', 'bankSha256', 'validators', 'validation', 'evidenceSha256']
const HEX64 = /^[a-f0-9]{64}(?![\s\S])/
const HISTORY_BYTES = 4 << 20
export const MAX_POLICY_SIGNATURE_CHECKS = 512

export function policyTimestamp(value: unknown): number {
  requireValue(typeof value === 'string' && TIME.test(value), 'Timestamp')
  const time = Date.parse(value)
  requireValue(
    Number.isFinite(time) &&
      Number(value.slice(0, 4)) > 0 &&
      new Date(time).toISOString().replace('.000Z', 'Z') === value,
    'Calendar',
  )
  return time
}
function containerDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(containerDepth))
  if (value !== null && typeof value === 'object') return 1 + Math.max(0, ...Object.values(value).map(containerDepth))
  return 0
}
interface Policy {
  rev: number
  previousManifestSha256: string | null
  issuedAt: string
  expiresAt: string
  network: EpochPolicyNetwork
  tables: Record<string, { tableSha256: string; validation: string }>
  revocations: { epoch: number; tableSha256: string }[]
}
function policySchema(raw: Uint8Array): Policy {
  const f = fields(strictJson(raw), FIELDS)
  requireValue(f.v === 'solsentry/epoch-tables/1' && containerDepth(f) <= 8, 'Policy schema')
  requireValue(safeInteger(f.rev) && f.rev >= 1, 'Revision')
  requireValue(
    f.previousManifestSha256 === null ||
      (typeof f.previousManifestSha256 === 'string' && HEX64.test(f.previousManifestSha256)),
    'Previous digest',
  )
  const duration = policyTimestamp(f.expiresAt) - policyTimestamp(f.issuedAt)
  requireValue(duration > 0 && duration <= 48 * 3600000, 'Policy window')
  const network = fields(f.network, NETWORK)
  requireValue(
    typeof network.cluster === 'string' &&
      typeof network.genesisHash === 'string' &&
      NETWORK.slice(2).every((key) => safeInteger(network[key])),
    'Network schema',
  )
  const tables = object(f.tables)
  requireValue(Object.keys(tables).length <= 32, 'Table count')
  for (const [epoch, value] of Object.entries(tables)) {
    requireValue(/^(?:0|[1-9][0-9]*)(?![\s\S])/.test(epoch) && safeInteger(Number(epoch)), 'Epoch key')
    const t = fields(value, TABLE)
    requireValue(
      ['tableSha256', 'bankSha256', 'evidenceSha256'].every(
        (key) => typeof t[key] === 'string' && HEX64.test(t[key] as string),
      ),
      'Table digest',
    )
    requireValue(
      safeInteger(t.validators) &&
        t.validators >= 1 &&
        t.validators <= 2000 &&
        safeInteger(t.tableBytes) &&
        t.tableBytes === 32 + 56 * t.validators &&
        safeInteger(t.bankSlot),
      'Table metadata',
    )
    requireValue(
      t.validation === 'operator-replayed-bank' || t.validation === 'operator-endorsed-public-snapshot',
      'Validation class',
    )
  }
  for (const entry of list(f.revocations, 32)) {
    const r = fields(entry, ['epoch', 'tableSha256', 'reason'])
    requireValue(
      safeInteger(r.epoch) &&
        typeof r.tableSha256 === 'string' &&
        HEX64.test(r.tableSha256) &&
        typeof r.reason === 'string',
      'Table revocation',
    )
  }
  requireValue(typeof f.reason === 'string', 'Reason')
  return f as unknown as Policy
}

/** Verify a complete contiguous history from revision 1, under caller-owned trust.
 * This does not fetch policy, authenticate caller time, persist a high-water mark,
 * or recover revoked-key history. Those deployment/bootstrap gates remain explicit.
 * No pins or accepted metadata are returned on refusal.
 */
export function verifyEpochPolicy(
  trust: EpochPolicyTrust,
  input: { keyDirectory: unknown; history: unknown; now: string },
): EpochPolicyVerification {
  const refuse = (step: PolicyStep): EpochPolicyVerification => ({ verdict: { result: 'refused', step } })
  let directory: ReturnType<typeof keyDirectory>
  let checks = MAX_POLICY_SIGNATURE_CHECKS
  const verify = (key: Uint8Array, sig: Uint8Array, bytes: Uint8Array) => {
    requireValue(checks-- > 0, 'Signature work limit')
    return signatureValid(key, sig, bytes)
  }
  let network: EpochPolicyNetwork
  try {
    network = { ...trust.network }
    directory = keyDirectory(input.keyDirectory, Uint8Array.from(trust.rootPublicKey), verify)
  } catch {
    return refuse('directory')
  }
  let history: JsonRecord
  try {
    history = fields(
      strictJson(
        input.history instanceof Uint8Array ? Uint8Array.from(input.history) : canonical(input.history),
        HISTORY_BYTES,
      ),
      ['v', 'entries'],
    )
    requireValue(history.v === 'epoch_tables_history/1' && list(history.entries, 64).length > 0, 'History')
  } catch {
    return refuse('schema')
  }
  let previous: Policy | undefined, previousRaw: Uint8Array | undefined
  const revoked = new Map<string, { epoch: number; sha256: string }>()
  const entries = history.entries as unknown[]
  for (let i = 0; i < entries.length; i++) {
    let raw: Uint8Array, sig: Uint8Array
    try {
      const entry = fields(entries[i], ['file', 'sig'])
      // Oversized signed files must reach the schema step, as the reference does.
      // Transport/history and crypto-work caps still bound pre-schema work.
      raw = base64url(entry.file, HISTORY_BYTES)
      sig = base64url(entry.sig, 64, 64)
    } catch {
      return refuse('signer')
    }
    let signers: typeof directory.delegations
    try {
      const checked = new Map<string, boolean>()
      signers = directory.delegations.filter((d) => {
        if (d.use !== 'epoch_tables') return false
        const id = digest(d.publicKey)
        if (!checked.has(id)) checked.set(id, verify(d.publicKey, sig, raw))
        return checked.get(id)
      })
    } catch {
      return refuse('signer')
    }
    if (!signers.length) return refuse('signer')
    let policy: Policy
    try {
      policy = policySchema(raw)
    } catch {
      return refuse('schema')
    }
    if (
      !signers.some(
        (d) =>
          d.notBefore <= policy.issuedAt &&
          policy.issuedAt < d.notAfter &&
          !directory.revocations.some((r) => r.keyId === d.keyId && r.from <= policy.issuedAt),
      )
    )
      return refuse('delegation')
    if (
      previous &&
      policy.rev === previous.rev &&
      (raw.length !== previousRaw!.length || !raw.every((byte, n) => byte === previousRaw![n]))
    )
      return refuse('equivocation')
    if (policy.rev !== i + 1 || policy.previousManifestSha256 !== (previousRaw ? digest(previousRaw) : null))
      return refuse('chain')
    if (Object.entries(policy.tables).some(([epoch, table]) => revoked.has(`${epoch}:${table.tableSha256}`)))
      return refuse('reauthorized')
    for (const r of policy.revocations)
      revoked.set(`${r.epoch}:${r.tableSha256}`, { epoch: r.epoch, sha256: r.tableSha256 })
    previous = policy
    previousRaw = raw
  }
  const policy = previous!
  let now: number
  try {
    now = policyTimestamp(input.now)
  } catch {
    return refuse('schema')
  }
  if (now < policyTimestamp(policy.issuedAt)) return refuse('not_yet')
  if (now >= policyTimestamp(policy.expiresAt)) return refuse('expired')
  // Additional caller-owned binding: signatures never choose the app's network.
  // Check all history entries too, so an otherwise signed chain cannot change networks.
  try {
    for (const entry of entries) {
      const f = object(strictJson(base64url(object(entry).file, HISTORY_BYTES)))
      const n = object(f.network)
      requireValue(
        NETWORK.every((key) => n[key] === network[key]),
        'Policy network',
      )
    }
  } catch {
    return refuse('network')
  }
  const pins: [number, string][] = Object.entries(policy.tables)
    .filter(
      ([epoch, table]) =>
        table.validation === 'operator-replayed-bank' && !revoked.has(`${epoch}:${table.tableSha256}`),
    )
    .map(([epoch, table]) => [Number(epoch), table.tableSha256])
  pins.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
  return {
    verdict: { result: 'ok', pins },
    accepted: Object.freeze({
      rev: policy.rev,
      manifestSha256: digest(previousRaw!),
      issuedAt: policy.issuedAt,
      expiresAt: policy.expiresAt,
      network: Object.freeze(network),
      tablePins: Object.freeze(pins.map(([epoch, sha256]) => Object.freeze({ epoch, sha256 }))),
      revoked: Object.freeze([...revoked.values()].map((r) => Object.freeze(r))),
    }),
  }
}
