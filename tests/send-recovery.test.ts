import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Transact } from '../src/wallet/mwa-session'
import {
  blockedByPending,
  guardAfterEdit,
  hasMatchingTransfer,
  recoverPendingSend,
  sendTracked,
  SendOutcomeUnknownError,
  type PendingGuard,
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

const deps = (transact: Transact) => ({
  transact,
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
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

const parsedTx = (instructions: unknown[], blockTime = T0 / 1000 + 30, err: unknown = null) => ({
  blockTime,
  meta: { err },
  transaction: { message: { recentBlockhash: BLOCKHASH, instructions } },
})

/**
 * Fake public RPC on a fake clock. Each call advances the clock by `latencyMs`; sleep advances it
 * by the requested amount. `chain(t)` describes what the chain shows at time t.
 */
function fakeRpc(chain: (t: number) => { height: number; sigs: { signature: string; err: null; blockTime: number }[]; txs: Record<string, unknown> }) {
  let now = T0 + 90_000 // the wallet timed out after 90 s
  const calls: { method: string; at: number }[] = []
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, at: now })
    const c = chain(now)
    now += 200
    if (method === 'getBlockHeight') return { result: c.height }
    if (method === 'getSignaturesForAddress') {
      expect((params[1] as { limit: number }).limit).toBe(10)
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
    elapsed: () => now - (T0 + 90_000),
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
      height: 990,
      // The transfer shows up a few seconds into the check.
      sigs: t > T0 + 95_000 ? [{ signature: SIG, err: null, blockTime: T0 / 1000 + 40 }] : [],
      txs: { [SIG]: parsedTx([transferIx(Number(LAMPORTS))]) },
    }))
    const r = await recoverPendingSend(err.pending, rpc.deps)
    expect(r).toEqual({ status: 'found', signature: SIG })
    spacing(rpc.calls)
  })

  it('a dropped session after the request was sent is also "unknown", not a cancel', async () => {
    const w = fakeWallet(() => Object.assign(new Error('closed'), { code: 'ERROR_SESSION_CLOSED' }))
    const err = await sendTracked(deps(w.transact), { recipient: RECIPIENT, lamports: LAMPORTS, checkedAt: T0 }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(SendOutcomeUnknownError)
  })

  it('timeout -> blockhash expires and nothing found -> Not sent', async () => {
    const other = 'OtherSig1111111111111111111111111111111111111'
    const rpc = fakeRpc((t) => ({
      height: t > T0 + 100_000 ? 1001 : 995,
      sigs: [{ signature: other, err: null, blockTime: T0 / 1000 + 10 }],
      // Same sender, different amount: not ours.
      txs: { [other]: parsedTx([transferIx(49_000_000)]) },
    }))
    const r = await recoverPendingSend(pending, rpc.deps)
    expect(r).toEqual({ status: 'expired' })
    // The other transaction was read once, then remembered.
    expect(rpc.calls.filter((c) => c.method === 'getTransaction')).toHaveLength(1)
    spacing(rpc.calls)
  })

  it('timeout -> cap hit before expiry -> unknown; Send stays held for the same recipient+amount', async () => {
    const rpc = fakeRpc(() => ({ height: 990, sigs: [], txs: {} }))
    const r = await recoverPendingSend(pending, rpc.deps)
    expect(r).toEqual({ status: 'unknown' })
    expect(rpc.elapsed()).toBeLessThanOrEqual(90_000 + 2_000)
    expect(rpc.calls.length).toBeLessThanOrEqual(46)
    spacing(rpc.calls)

    const checking: PendingGuard = { recipient: RECIPIENT, lamports: LAMPORTS, phase: 'checking' }
    // While checking: nothing goes, whatever the fields say.
    expect(blockedByPending(checking, RECIPIENT, LAMPORTS)).toBe(true)
    expect(blockedByPending(checking, RECIPIENT, 1n)).toBe(true)
    expect(guardAfterEdit(checking)).toBe(checking)
    const unconfirmed: PendingGuard = { ...checking, phase: 'unconfirmed' }
    expect(blockedByPending(unconfirmed, RECIPIENT, LAMPORTS)).toBe(true)
    expect(blockedByPending(unconfirmed, RECIPIENT, LAMPORTS + 1n)).toBe(false)
    expect(blockedByPending(unconfirmed, SENDER_B58, LAMPORTS)).toBe(false)
    // Editing after the check ended releases it.
    expect(guardAfterEdit(unconfirmed)).toBeNull()
    expect(blockedByPending(null, RECIPIENT, LAMPORTS)).toBe(false)
  })

  it('a miss with a full page of new signatures proves nothing: no "Not sent"', async () => {
    const sigs = Array.from({ length: 10 }, (_, i) => ({ signature: `spam${i}`, err: null, blockTime: T0 / 1000 + 5 }))
    const txs = Object.fromEntries(sigs.map((s) => [s.signature, parsedTx([transferIx(1, SENDER_B58)])]))
    const rpc = fakeRpc(() => ({ height: 1001, sigs, txs }))
    expect(await recoverPendingSend(pending, rpc.deps)).toEqual({ status: 'unknown' })
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
      height: 990,
      sigs: [
        { signature: 'noise', err: null, blockTime: T0 / 1000 + 50 },
        { signature: mine, err: null, blockTime: T0 / 1000 + 40 },
      ],
      txs: {
        noise: parsedTx([computeBudgetIx]),
        [mine]: parsedTx([computeBudgetIx, lighthouseIx, transferIx(Number(LAMPORTS)), lighthouseIx]),
      },
    }))
    expect(await recoverPendingSend(pending, rpc.deps)).toEqual({ status: 'found', signature: mine })
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
