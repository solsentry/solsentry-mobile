// Sends whose outcome is not known for sure (the request reached the wallet and no signature came
// back). Each one locks Send for its recipient+amount. Fail closed:
//   - written (and persisted) right before the wallet is asked; a failed save keeps the in-memory
//     lock and warns;
//   - editing the form never unlocks it (restoring the same pair would invite a second, paid send);
//   - "Not sent" (blockhash horizon passed, nothing on chain) does NOT unlock it either: a wallet
//     that rewrote the blockhash and was approved after the prompt closed could still land it;
//   - it expires only once the chain height was seen past the expiry horizon AND PENDING_TTL_MS
//     passed on the device clock (a skewed clock or an unreachable RPC cannot release it early),
//     or when the transfer is found, or when the user confirms they checked the wallet history.
// No React Native imports here (the storage is passed in).
import type { PendingSend, RecoveryResult } from './send-recovery'

export const PENDING_TTL_MS = 10 * 60_000
export const PENDING_STORAGE_KEY = 'solsentry-guard-mobile/pending-sends/v1'
export const RESTORED_NOTICE =
  'A previous send to this address may still be processing — check your wallet history'
export const SAVE_FAILED_NOTICE =
  "Couldn't save the send status on this device — don't resend before checking your wallet history"
export const LOAD_FAILED_NOTICE =
  "Couldn't read the saved send status on this device — don't resend before checking your wallet history"
export const CHECKED_HISTORY_LABEL = 'I checked my wallet history'
/** Where an unreadable stored value is copied before it is treated as a failed load (never lost). */
export const PENDING_BACKUP_KEY = `${PENDING_STORAGE_KEY}/unreadable-backup`
export const LOAD_FAILED_LOCK_NOTICE =
  'Sending is paused until the saved send status is read. Tap "Retry", or check your wallet history for a ' +
  `send that may still be processing and then tap "${CHECKED_HISTORY_LABEL}".`

export type PendingStatus =
  /** No answer yet (wallet timed out / session dropped, or the check hit its time cap). */
  | 'unconfirmed'
  /** Horizon passed and nothing was found on chain. */
  | 'not-seen'
  /** The wallet answered with a decline after it got the request. */
  | 'declined'

export interface PendingRecord extends PendingSend {
  status: PendingStatus
  /** A confirmed height past the expiry horizon was seen (persisted). */
  pastHorizon?: boolean
  /** Loaded from storage (the app restarted or the screen remounted since the send); not persisted. */
  restored?: boolean
  /** The last save of this record failed: the lock lives in memory only; not persisted. */
  unsaved?: boolean
}

/** Keyed by pendingKey(recipient, lamports). */
export type PendingMap = Readonly<Record<string, PendingRecord>>

export function pendingKey(recipient: string, lamports: bigint): string {
  return `${recipient}|${lamports.toString()}`
}

/** Device time after which the lock may lapse (it also needs pastHorizon). */
export function releaseAt(r: PendingRecord): number {
  return r.startedAt + PENDING_TTL_MS
}

export function isLive(r: PendingRecord, now: number): boolean {
  return !(r.pastHorizon && now >= releaseAt(r))
}

/** Drop records that may lapse. */
export function prunePending(map: PendingMap, now: number): PendingMap {
  const out: Record<string, PendingRecord> = {}
  for (const [k, r] of Object.entries(map)) if (isLive(r, now)) out[k] = r
  return out
}

export function addPending(map: PendingMap, p: PendingSend): PendingMap {
  return { ...map, [pendingKey(p.recipient, p.lamports)]: { ...p, status: 'unconfirmed' } }
}

/** Remove a record: only for a found transfer, or the user's "I checked my wallet history". */
export function removePending(map: PendingMap, recipient: string, lamports: bigint): PendingMap {
  const { [pendingKey(recipient, lamports)]: _gone, ...rest } = map
  return rest
}

function patch(map: PendingMap, recipient: string, lamports: bigint, fields: Partial<PendingRecord>): PendingMap {
  const key = pendingKey(recipient, lamports)
  const cur = map[key]
  return cur ? { ...map, [key]: { ...cur, ...fields } } : map
}

export function markDeclined(map: PendingMap, recipient: string, lamports: bigint): PendingMap {
  return patch(map, recipient, lamports, { status: 'declined' })
}

export function markUnsaved(map: PendingMap, recipient: string, lamports: bigint, unsaved: boolean): PendingMap {
  return patch(map, recipient, lamports, { unsaved })
}

/** The record that locks Send for this recipient+amount, if any. */
export function lockedFor(
  map: PendingMap,
  recipient: string,
  lamports: bigint | null,
  now: number,
): PendingRecord | null {
  if (!recipient || lamports === null) return null
  const r = map[pendingKey(recipient, lamports)]
  return r && isLive(r, now) ? r : null
}

/**
 * Fold a network check into the map. Only "found" clears the record. "Not sent" becomes
 * 'not-seen' and stays locked; "unknown" keeps the status. The expiry anchor (endHeight) and the
 * horizon flag are kept so the lock can lapse later and a re-check keeps the same horizon.
 */
export function applyRecovery(map: PendingMap, p: PendingSend, r: RecoveryResult): PendingMap {
  if (r.status === 'found') return removePending(map, p.recipient, p.lamports)
  const key = pendingKey(p.recipient, p.lamports)
  const cur: PendingRecord = map[key] ?? { ...p, status: 'unconfirmed' }
  return {
    ...map,
    [key]: {
      ...cur,
      status: r.status === 'expired' ? 'not-seen' : cur.status,
      endHeight: cur.endHeight ?? r.endHeight,
      pastHorizon: !!(cur.pastHorizon || r.pastHorizon || r.status === 'expired'),
    },
  }
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What the pending box says for this record. */
export function pendingMessage(r: PendingRecord): string {
  if (r.status === 'not-seen') {
    return (
      'Not seen on the network. If you approved it in your wallet after the prompt closed, it may still land — ' +
      `check your wallet history. You can send again after ${clock(releaseAt(r))}.`
    )
  }
  if (r.status === 'declined') {
    return `Cancelled in your wallet. As a precaution this amount to this address stays paused; tap "${CHECKED_HISTORY_LABEL}" to send it again.`
  }
  if (r.restored) return RESTORED_NOTICE
  return "Could not confirm yet — check your wallet's history before trying again."
}

export function serializePending(map: PendingMap): string {
  return JSON.stringify(
    Object.values(map).map(({ restored: _r, unsaved: _u, lamports, ...rest }) => ({
      ...rest,
      lamports: lamports.toString(),
    })),
  )
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const STATUSES: readonly string[] = ['unconfirmed', 'not-seen', 'declined']

/** Parse what serializePending wrote; malformed and lapsed entries are dropped. Marks all as restored. */
export function parsePending(raw: string | null, now: number): PendingMap {
  if (!raw) return {}
  const rows: unknown = JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('pending-sends: not a list')
  let map: PendingMap = {}
  for (const x of rows as Record<string, unknown>[]) {
    if (!x || !str(x.sender) || !str(x.recipient) || !str(x.blockhash) || !str(x.lamports)) continue
    if (!num(x.lastValidBlockHeight) || !num(x.startedAt) || !num(x.startSlot)) continue
    let lamports: bigint
    try {
      lamports = BigInt(x.lamports)
    } catch {
      continue
    }
    const rec: PendingRecord = {
      sender: x.sender,
      recipient: x.recipient,
      lamports,
      blockhash: x.blockhash,
      lastValidBlockHeight: x.lastValidBlockHeight,
      startedAt: x.startedAt,
      startSlot: x.startSlot,
      ...(num(x.endHeight) ? { endHeight: x.endHeight } : {}),
      status: (STATUSES.includes(x.status as string) ? x.status : 'unconfirmed') as PendingStatus,
      ...(x.pastHorizon === true ? { pastHorizon: true } : {}),
      restored: true,
    }
    if (isLive(rec, now)) map = { ...map, [pendingKey(rec.recipient, rec.lamports)]: rec }
  }
  return map
}

/** The two AsyncStorage methods used here. */
export interface KeyValueStore {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export interface LoadResult {
  map: PendingMap
  ok: boolean
}

/**
 * ok=false: storage could not be read (or held garbage); the caller must fail closed, not assume
 * "no pending send". Garbage is first copied to PENDING_BACKUP_KEY (best effort), since the next
 * save overwrites the main key.
 */
export async function loadPending(kv: KeyValueStore, now: number): Promise<LoadResult> {
  let raw: string | null
  try {
    raw = await kv.getItem(PENDING_STORAGE_KEY)
  } catch {
    return { map: {}, ok: false }
  }
  try {
    return { map: parsePending(raw, now), ok: true }
  } catch {
    try {
      if (raw !== null) await kv.setItem(PENDING_BACKUP_KEY, raw)
    } catch {
      // Backup failed too: still a failed load (fail closed).
    }
    return { map: {}, ok: false }
  }
}

/**
 * Whether the stored locks are known. 'failed': the load failed, so Send is off for EVERY
 * recipient until a retry succeeds ('ready') or the user confirms they checked the wallet history
 * ('released').
 */
export type LoadGate = 'loading' | 'ready' | 'failed' | 'released'

export function loadGateAllowsSend(gate: LoadGate): boolean {
  return gate === 'ready' || gate === 'released'
}

/** Fold a (re)load into the in-memory locks. Records written in this session win over stored ones. */
export function applyLoad(current: PendingMap, gate: LoadGate, res: LoadResult): { map: PendingMap; gate: LoadGate } {
  return {
    map: { ...res.map, ...current },
    gate: res.ok ? 'ready' : gate === 'released' ? 'released' : 'failed',
  }
}

/** "I checked my wallet history" on the load-failed box. */
export function releaseLoadGate(gate: LoadGate): LoadGate {
  return gate === 'failed' ? 'released' : gate
}

/** Throws when the save fails; the caller keeps its in-memory lock and warns. */
export async function savePending(kv: KeyValueStore, map: PendingMap): Promise<void> {
  await kv.setItem(PENDING_STORAGE_KEY, serializePending(map))
}
