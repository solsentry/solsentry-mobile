// Sends whose outcome is not known yet (the wallet timed out after the request reached it).
// Each one locks Send for its recipient+amount until the chain gives a definite answer (found, or
// not sent) or PENDING_TTL_MS passes. Editing the form never unlocks it: restoring the same
// recipient+amount would otherwise invite a second, paid send. The map is persisted, so a remount
// or an app restart keeps the lock. No React Native imports here (the storage is passed in).
import type { PendingSend, RecoveryResult } from './send-recovery'

export const PENDING_TTL_MS = 10 * 60_000
export const PENDING_STORAGE_KEY = 'solsentry-guard-mobile/pending-sends/v1'
export const RESTORED_NOTICE =
  'A previous send to this address may still be processing — check your wallet history'

export interface PendingRecord extends PendingSend {
  /** Loaded from storage (the app restarted or the screen remounted since the send); not persisted. */
  restored?: boolean
}

/** Keyed by pendingKey(recipient, lamports). */
export type PendingMap = Readonly<Record<string, PendingRecord>>

export function pendingKey(recipient: string, lamports: bigint): string {
  return `${recipient}|${lamports.toString()}`
}

export function isLive(r: PendingRecord, now: number): boolean {
  return now - r.startedAt < PENDING_TTL_MS
}

/** Drop records past their TTL. */
export function prunePending(map: PendingMap, now: number): PendingMap {
  const out: Record<string, PendingRecord> = {}
  for (const [k, r] of Object.entries(map)) if (isLive(r, now)) out[k] = r
  return out
}

export function addPending(map: PendingMap, p: PendingSend): PendingMap {
  return { ...map, [pendingKey(p.recipient, p.lamports)]: { ...p } }
}

export function removePending(map: PendingMap, recipient: string, lamports: bigint): PendingMap {
  const { [pendingKey(recipient, lamports)]: _gone, ...rest } = map
  return rest
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
 * Fold a network check into the map: a definite answer (found / not sent) clears the record;
 * "unknown" keeps it (with the expiry anchor the check used, so a re-check keeps the same horizon).
 */
export function applyRecovery(map: PendingMap, p: PendingSend, r: RecoveryResult): PendingMap {
  const key = pendingKey(p.recipient, p.lamports)
  if (r.status === 'found' || r.status === 'expired') return removePending(map, p.recipient, p.lamports)
  const cur = map[key] ?? p
  return { ...map, [key]: { ...cur, endHeight: cur.endHeight ?? r.endHeight } }
}

export function serializePending(map: PendingMap): string {
  return JSON.stringify(
    Object.values(map).map(({ restored: _r, lamports, ...rest }) => ({ ...rest, lamports: lamports.toString() })),
  )
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Parse what serializePending wrote; malformed entries and expired ones are dropped. Marks all as restored. */
export function parsePending(raw: string | null, now: number): PendingMap {
  if (!raw) return {}
  let rows: unknown
  try {
    rows = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!Array.isArray(rows)) return {}
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

export async function loadPending(kv: KeyValueStore, now: number): Promise<PendingMap> {
  try {
    return parsePending(await kv.getItem(PENDING_STORAGE_KEY), now)
  } catch {
    return {}
  }
}

export async function savePending(kv: KeyValueStore, map: PendingMap): Promise<void> {
  try {
    await kv.setItem(PENDING_STORAGE_KEY, serializePending(map))
  } catch {
    // Best effort: the in-memory lock still holds for this session.
  }
}
