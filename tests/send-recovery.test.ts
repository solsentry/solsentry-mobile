import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Transact } from '../src/wallet/mwa-session'
import {
  addPending,
  applyRecovery,
  loadPending,
  lockedFor,
  PENDING_STORAGE_KEY,
  PENDING_TTL_MS,
  removePending,
  savePending,
  type KeyValueStore,
} from '../src/wallet/pending-sends'
import {
  expiryHorizon,
  hasMatchingTransfer,
  isOurTransfer,
  recoverPendingSend,
  sendTracked,
  SendOutcomeUnknownError,
  type PendingSend,
} from '../src/wallet/send-recovery'

const SENDER = new PublicKey('4kxscuteRLQdNiTXA33YYsvywAPNA6DQTifswxjL5pH1')
const SENDER_B58 = SENDER.toBase58()
const RECIPIENT = 'So11111111111111111111111111111111111111112'
const B64 = Buffer.from(SENDER.toBytes()).toString('base64')
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'
const T0 = 1_760_000_000_000
const LAMPORTS = 50_000_000n

const timeoutErr = () =>
  new Error('java.util.concurrent.TimeoutException: Timed out waiting for response with id=2')
const declineErr = () =>
  Object.assign(new Error('transaction not signed'), { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: -3 } })

/** Fake wallet + transact: signAndSendTransactions answers with `onSend`. */
function fakeWallet(onSend: () => string[] | Error) {
  let sends = 0
  const wallet = {
    authorize: async () => ({ auth_token: 't', accounts: [{ address: B64, label: 'Seed Vault' }] }),
    signAndSendTransactions: async () => {
      sends++
      const r = onSend()
      if (r instanceof Error) throw r
      return r
    },
  }
  const transact = (async (cb: (w: never) => unknown) => cb(wallet as never)) as Transact
  return { transact, sends: () => sends }
}

const START_SLOT = 5_000

const deps = (transact: Transact) => ({
  transact,
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
  getSlot: async () => START_SLOT,
  maxVerdictAgeMs: 300_000,
  now: () => T0,
})

const pending: PendingSend = {
  sender: SENDER_B58,
  recipient: RECIPIENT,
  lamports: LAMPORTS,
  blockhash: BLOCKHASH,
  lastValidBlockHeight: 1000,
  startedAt: T0,
  startSlot: START_SLOT,
}

const transferIx = (lamports: number, destination = RECIPIENT) => ({
  program: 'system',
  programId: '11111111111111111111111111111111',
  parsed: { type: 'transfer', info: { source: SENDER_B58, destination, lamports } },
})
const computeBudgetIx = {
  programId: 'ComputeBudget111111111111111111111111111111',
  data: '3DdGGhkhJbjm',
  accounts: [],
}
const lighthouseIx = { programId: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', data: 'xyz', accounts: [] }

const parsedTx = (
  instructions: unknown[],
  blockTime = T0 / 1000 + 30,
  err: unknown = null,
  recentBlockhash = BLOCKHASH,
  slot = START_SLOT + 10,
) => ({
  slot,
  blockTime,
  meta: { err },
  transaction: { message: { recentBlockhash, instructions } },
})

type Row = { signature: string; slot: number; err: null; blockTime: number }
/** A signature from before the send: makes a page reach back past the send-start slot. */
const OLD_ROW: Row = { signature: 'old', slot: START_SLOT - 10, err: null, blockTime: T0 / 1000 - 3600 }
const row = (signature: string, slot = START_SLOT + 10, blockTime = T0 / 1000 + 30): Row => ({
  signature,
  slot,
  err: null,
  blockTime,
})

const REC_START = T0 + 90_000 // the wallet timed out after 90 s
/** Confirmed height when the check starts (endHeight), then one block every 400 ms. */
const H0 = 995
const growing = (t: number) => H0 + Math.floor((t - REC_START) / 400)
const HORIZON = Math.max(1000, H0 + 151) + 20

interface ChainView {
  height: number
  /** How many signature scans already ran after a getBlockHeight answer past HORIZON. */
  scansPastHorizon: number
}

/**
 * Fake public RPC on a fake clock. Each call advances the clock by 200 ms; sleep advances it by the
 * requested amount. `chain(t, view)` describes what the chain shows.
 */
function fakeRpc(
  chain: (t: number, v: ChainView) => { height?: number; sigs: Row[]; txs: Record<string, unknown> },
) {
  let now = REC_START
  let scansPastHorizon = 0
  let lastHeight = 0
  const calls: { method: string; at: number; height: number }[] = []
  const rpc = async (method: string, params: unknown[]) => {
    const height0 = chain(now, { height: 0, scansPastHorizon }).height ?? growing(now)
    const c = chain(now, { height: height0, scansPastHorizon })
    calls.push({ method, at: now, height: height0 })
    now += 200
    if (method === 'getBlockHeight') {
      expect(params[0]).toEqual({ commitment: 'confirmed' })
      lastHeight = height0
      return { result: height0 }
    }
    if (method === 'getSignaturesForAddress') {
      expect((params[1] as { limit: number }).limit).toBe(10)
      if (lastHeight > HORIZON) scansPastHorizon++
      return { result: c.sigs }
    }
    if (method === 'getTransaction') {
      expect(params[1]).toMatchObject({ encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 })
      return { result: c.txs[params[0] as string] ?? null }
    }
    throw new Error(`unexpected ${method}`)
  }
  return {
    calls,
    deps: {
      rpc,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    },
    elapsed: () => now - REC_START,
  }
}

function spacing(calls: { at: number }[]) {
  for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(2_000)
}

describe('wallet timeout after the request was sent', () => {
  it('timeout -> outcome unknown with the recorded request; tx found -> Submitted with its signature', async () => {
    const w = fakeWallet(timeoutErr)
    const err = await sendTracked(deps(w.transact), { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(SendOutcomeUnknownError)
    expect(err.pending).toEqual(pending)

    const SIG = 'LNJCnhZ7mVj8fnhCXMwy71VTPQoHwxXTgHU3nQnjpTz21YtTpuPzHJS8SKDCbPBHhMJqSsCQrbBRox7ciXVT6ED'
    const rpc = fakeRpc((t) => ({
      // The transfer shows up a few seconds into the check.
      sigs: t > REC_START + 5_000 ? [row(SIG), OLD_ROW] : [OLD_ROW],
      txs: { [SIG]: parsedTx([transferIx(Number(LAMPORTS))]) },
    }))
    const r = await recoverPendingSend(err.pending, rpc.deps)
    expect(r).toMatchObject({ status: 'found', signature: SIG, endHeight: H0 })
    spacing(rpc.calls)
  })

  it('a dropped session after the request was sent is also "unknown", not a cancel', async () => {
    const w = fakeWallet(() => Object.assign(new Error('closed'), { code: 'ERROR_SESSION_CLOSED' }))
    const err = await sendTracked(deps(w.transact), { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(SendOutcomeUnknownError)
  })

  it('timeout -> past the horizon, two clean complete scans >= 4 s apart -> Not sent', async () => {
    const other = 'OtherSig1111111111111111111111111111111111111'
    const rpc = fakeRpc(() => ({
      sigs: [row(other), OLD_ROW],
      // Same sender, different amount: not ours.
      txs: { [other]: parsedTx([transferIx(49_000_000)]) },
    }))
    const r = await recoverPendingSend(pending, rpc.deps)
    expect(r).toEqual({ status: 'expired', endHeight: H0 })
    // Our own blockhash died at 1000, but "Not sent" waits for the rewrite horizon too.
    const scans = rpc.calls.filter((c) => c.method === 'getSignaturesForAddress' && c.height > HORIZON)
    expect(scans.length).toBe(2)
    expect(scans[1].at - scans[0].at).toBeGreaterThanOrEqual(4_000)
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress' && c.height <= HORIZON).length).toBeGreaterThan(0)
    // The other transaction was read once, then remembered.
    expect(rpc.calls.filter((c) => c.method === 'getTransaction')).toHaveLength(1)
    expect(rpc.elapsed()).toBeLessThanOrEqual(90_000)
    spacing(rpc.calls)
  })

  it('lagging RPC: first scan past the horizon misses, the re-scan finds it -> Submitted, not "Not sent"', async () => {
    const mine = 'Mine1111111111111111111111111111111111111111'
    const rpc = fakeRpc((_t, v) => ({
      sigs: v.scansPastHorizon >= 1 ? [row(mine), OLD_ROW] : [OLD_ROW],
      txs: { [mine]: parsedTx([transferIx(Number(LAMPORTS))]) },
    }))
    expect(await recoverPendingSend(pending, rpc.deps)).toMatchObject({ status: 'found', signature: mine })
  })

  it('a short page that does not reach back past the send-start slot proves nothing', async () => {
    const rpc = fakeRpc(() => ({ sigs: [row('n1', START_SLOT + 3)], txs: { n1: parsedTx([computeBudgetIx]) } }))
    expect(await recoverPendingSend(pending, rpc.deps)).toEqual({ status: 'unknown', endHeight: H0 })
  })

  it('timeout -> cap hit before expiry -> unknown; Send stays held for the same recipient+amount', async () => {
    const rpc = fakeRpc(() => ({ height: 990, sigs: [OLD_ROW], txs: {} }))
    const r = await recoverPendingSend(pending, rpc.deps)
    expect(r.status).toBe('unknown')
    expect(rpc.elapsed()).toBeLessThanOrEqual(90_000 + 2_000)
    expect(rpc.calls.length).toBeLessThanOrEqual(46)
    spacing(rpc.calls)

    // The record stays: "could not confirm" keeps Send locked for this recipient+amount.
    let map = applyRecovery(addPending({}, pending), pending, r)
    const now = T0 + 120_000
    expect(lockedFor(map, RECIPIENT, LAMPORTS, now)).not.toBeNull()
    // Edit-and-restore: change the amount (another pair is free), then type the same amount back.
    expect(lockedFor(map, RECIPIENT, LAMPORTS + 1n, now)).toBeNull()
    expect(lockedFor(map, SENDER_B58, LAMPORTS, now)).toBeNull()
    expect(lockedFor(map, RECIPIENT, LAMPORTS, now)).not.toBeNull()
    // Only a definite answer or the TTL releases it.
    expect(lockedFor(map, RECIPIENT, LAMPORTS, T0 + PENDING_TTL_MS)).toBeNull()
    map = applyRecovery(map, pending, { status: 'expired' })
    expect(lockedFor(map, RECIPIENT, LAMPORTS, now)).toBeNull()
  })

  it('a miss with a full page of new signatures proves nothing: no "Not sent"', async () => {
    const sigs = Array.from({ length: 10 }, (_, i) => row(`spam${i}`, START_SLOT + 1 + i))
    const txs = Object.fromEntries(sigs.map((s) => [s.signature, parsedTx([transferIx(1, SENDER_B58)])]))
    const rpc = fakeRpc(() => ({ sigs, txs }))
    expect((await recoverPendingSend(pending, rpc.deps)).status).toBe('unknown')
  })

  it('device clock 30 min ahead of the chain: our blockhash still binds the transfer', async () => {
    const mine = 'Mine1111111111111111111111111111111111111111'
    const skewed = { ...pending, startedAt: T0 + 30 * 60_000 }
    const rpc = fakeRpc(() => ({
      sigs: [row(mine, START_SLOT + 10, T0 / 1000 + 40), OLD_ROW],
      txs: { [mine]: parsedTx([transferIx(Number(LAMPORTS))], T0 / 1000 + 40) },
    }))
    expect(await recoverPendingSend(skewed, rpc.deps)).toMatchObject({ status: 'found', signature: mine })
  })
})

describe('wallet that rewrites the blockhash', () => {
  const OTHER_HASH = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  it('accepted when the slot is at/after send start and the block time within ±10 min', () => {
    const tx = parsedTx([transferIx(Number(LAMPORTS))], T0 / 1000 + 300, null, OTHER_HASH, START_SLOT + 1)
    expect(isOurTransfer(tx, {}, pending)).toBe(true)
  })
  it('an earlier identical transfer (slot before send start) is not ours', () => {
    const tx = parsedTx([transferIx(Number(LAMPORTS))], T0 / 1000 - 5, null, OTHER_HASH, START_SLOT - 1)
    expect(isOurTransfer(tx, {}, pending)).toBe(false)
  })
  it('a block time outside ±10 min is not ours', () => {
    const tx = parsedTx([transferIx(Number(LAMPORTS))], T0 / 1000 + 601, null, OTHER_HASH, START_SLOT + 1)
    expect(isOurTransfer(tx, {}, pending)).toBe(false)
  })
  it('the expiry horizon is never earlier than our own blockhash expiry', () => {
    expect(expiryHorizon(pending, 800)).toBeGreaterThan(pending.lastValidBlockHeight)
    expect(expiryHorizon(pending, 995)).toBe(995 + 151 + 20)
  })
})

describe('matching the transfer', () => {
  it('finds the transfer among ComputeBudget / Lighthouse instructions', () => {
    const tx = parsedTx([computeBudgetIx, computeBudgetIx, transferIx(Number(LAMPORTS)), lighthouseIx])
    expect(hasMatchingTransfer(tx, pending)).toBe(true)
  })

  it('wrong amount, wrong recipient or a failed tx is not a match', () => {
    expect(hasMatchingTransfer(parsedTx([transferIx(Number(LAMPORTS) + 1)]), pending)).toBe(false)
    expect(hasMatchingTransfer(parsedTx([transferIx(Number(LAMPORTS), SENDER_B58)]), pending)).toBe(false)
    expect(hasMatchingTransfer(parsedTx([transferIx(Number(LAMPORTS))], T0 / 1000, { InstructionError: [0, 'x'] }), pending)).toBe(
      false,
    )
  })

  it('recovery picks the wallet-wrapped transfer out of a busy history', async () => {
    const mine = 'Mine1111111111111111111111111111111111111111'
    const rpc = fakeRpc(() => ({
      sigs: [row('noise', START_SLOT + 20), row(mine), OLD_ROW],
      txs: {
        noise: parsedTx([computeBudgetIx]),
        [mine]: parsedTx([computeBudgetIx, lighthouseIx, transferIx(Number(LAMPORTS)), lighthouseIx]),
      },
    }))
    expect(await recoverPendingSend(pending, rpc.deps)).toMatchObject({ status: 'found', signature: mine })
  })
})

describe('decline in the wallet', () => {
  it('stays a plain cancel: no outcome-unknown error, so no polling', async () => {
    const w = fakeWallet(declineErr)
    const err = await sendTracked(deps(w.transact), { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 }).catch(
      (e) => e,
    )
    expect(w.sends()).toBe(1)
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError)
    const { describeError, CANCELLED_SEND } = await import('../src/ui/errors')
    expect(describeError(err, 'send').message).toBe(CANCELLED_SEND)
  })

  it('a failure before the request reached the wallet is reported as is', async () => {
    const w = fakeWallet(() => ['sig'])
    const d = { ...deps(w.transact), getLatestBlockhash: async () => Promise.reject(new Error('Network request failed')) }
    const err = await sendTracked(d, { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 }).catch((e) => e)
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError)
    expect(w.sends()).toBe(0)
  })

  it('a normal success returns the signature', async () => {
    const w = fakeWallet(() => ['abc'])
    const r = await sendTracked(deps(w.transact), { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 })
    expect(r.signature).toBe('abc')
    expect(r.from).toBe(SENDER_B58)
  })
})

describe('pending-send lock', () => {
  const memoryStore = () => {
    const data = new Map<string, string>()
    const kv: KeyValueStore = {
      getItem: async (k) => data.get(k) ?? null,
      setItem: async (k, v) => {
        data.set(k, v)
      },
    }
    return { kv, data }
  }

  it('is recorded before the wallet is asked, and the timeout error carries the session', async () => {
    const order: string[] = []
    const w = fakeWallet(() => {
      order.push('wallet')
      return timeoutErr()
    })
    const err = await sendTracked(deps(w.transact), {
      recipient: RECIPIENT,
      lamports: LAMPORTS,
      checkedAt: T0,
      onPending: (p) => order.push(`pending:${p.recipient}`),
    }).catch((e) => e)
    expect(order).toEqual([`pending:${RECIPIENT}`, 'wallet'])
    expect(err).toBeInstanceOf(SendOutcomeUnknownError)
    expect(err.session).toMatchObject({ address: SENDER_B58, authToken: 't' })
  })

  it('survives a restart: persisted, restored, still locked for the same pair until TTL', async () => {
    const { kv, data } = memoryStore()
    const withEnd = applyRecovery(addPending({}, pending), pending, { status: 'unknown', endHeight: 995 })
    await savePending(kv, withEnd)
    expect(data.get(PENDING_STORAGE_KEY)).toContain('"lamports":"50000000"')

    const restored = await loadPending(kv, T0 + 60_000)
    const lock = lockedFor(restored, RECIPIENT, LAMPORTS, T0 + 60_000)
    expect(lock).toMatchObject({ restored: true, lamports: LAMPORTS, endHeight: 995, startSlot: START_SLOT })
    // Past the TTL it is gone on load.
    expect(await loadPending(kv, T0 + PENDING_TTL_MS + 1)).toEqual({})
  })

  it('"Check again" outcomes: found clears, unknown keeps, garbage in storage is ignored', async () => {
    const map = addPending({}, pending)
    expect(lockedFor(applyRecovery(map, pending, { status: 'found', signature: 's' }), RECIPIENT, LAMPORTS, T0)).toBeNull()
    expect(lockedFor(applyRecovery(map, pending, { status: 'unknown' }), RECIPIENT, LAMPORTS, T0)).not.toBeNull()
    expect(lockedFor(removePending(map, RECIPIENT, LAMPORTS), RECIPIENT, LAMPORTS, T0)).toBeNull()
    const { kv, data } = memoryStore()
    data.set(PENDING_STORAGE_KEY, '[{"sender":1},"x",null]')
    expect(await loadPending(kv, T0)).toEqual({})
    data.set(PENDING_STORAGE_KEY, '{not json')
    expect(await loadPending(kv, T0)).toEqual({})
  })
})
