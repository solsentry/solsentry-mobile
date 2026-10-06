import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  isAuthorizationFailed,
  withAuthorizedWallet,
  type Transact,
  type WalletSession,
} from '../src/wallet/mwa-session'

const ADDR = new PublicKey('4kxscuteRLQdNiTXA33YYsvywAPNA6DQTifswxjL5pH1')
const B64 = Buffer.from(ADDR.toBytes()).toString('base64')

/** Inside transact, the RN module rejects with this shape (not yet wrapped by the library). */
const rnAuthFailed = () =>
  Object.assign(new Error('authorization request failed'), {
    code: 'JSON_RPC_ERROR',
    userInfo: { jsonRpcErrorCode: -1 },
  })
const sessionClosed = () => Object.assign(new Error('session closed'), { code: 'ERROR_SESSION_CLOSED' })

type AuthStep = (token: string | undefined) => { auth_token: string } | Error

/** Fake wallet + transact: `steps` answers each authorize call in order; records calls. */
function fake(steps: AuthStep[]) {
  const calls: (string | undefined)[] = []
  let transacts = 0
  let i = 0
  const wallet = {
    authorize: async (p: { auth_token?: string }) => {
      calls.push(p.auth_token)
      const r = steps[i++](p.auth_token)
      if (r instanceof Error) throw r
      return { auth_token: r.auth_token, accounts: [{ address: B64, label: 'Seed Vault' }] }
    },
  }
  const transact = (async (cb: (w: never) => unknown) => {
    transacts++
    return cb(wallet as never)
  }) as Transact
  return { transact, calls, transacts: () => transacts }
}

describe('MWA stale auth token', () => {
  it('detects -1 in both the raw RN shape and the wrapped library shape', () => {
    expect(isAuthorizationFailed(rnAuthFailed())).toBe(true)
    expect(isAuthorizationFailed(Object.assign(new Error('x'), { code: -1 }))).toBe(true)
    expect(isAuthorizationFailed(Object.assign(new Error('x'), { code: -3 }))).toBe(false)
    expect(isAuthorizationFailed(new Error('java.util.concurrent.CancellationException'))).toBe(false)
  })

  it('stale token -> fresh authorize in the same session; new token stored, work runs', async () => {
    const f = fake([() => rnAuthFailed(), () => ({ auth_token: 'fresh' })])
    const seen: WalletSession[] = []
    let rejected = 0
    const out = await withAuthorizedWallet(f.transact, 'stale', async (_w, s) => `sent from ${s.address}`, {
      onSession: (s) => seen.push(s),
      onTokenRejected: () => rejected++,
    })
    expect(out).toBe(`sent from ${ADDR.toBase58()}`)
    expect(f.calls).toEqual(['stale', undefined])
    expect(f.transacts()).toBe(1)
    expect(seen).toEqual([{ address: ADDR.toBase58(), authToken: 'fresh', label: 'Seed Vault' }])
    expect(rejected).toBe(0)
  })

  it('session closed after the rejection -> one more transact with a fresh authorize', async () => {
    const f = fake([() => rnAuthFailed(), () => sessionClosed(), () => ({ auth_token: 'fresh2' })])
    const out = await withAuthorizedWallet(f.transact, 'stale', async (_w, s) => s.authToken)
    expect(out).toBe('fresh2')
    expect(f.calls).toEqual(['stale', undefined, undefined])
    expect(f.transacts()).toBe(2)
  })

  it('user declines the fresh prompt -> no further retry, token dropped, error thrown', async () => {
    const f = fake([() => rnAuthFailed(), () => rnAuthFailed()])
    let rejected = 0
    await expect(
      withAuthorizedWallet(f.transact, 'stale', async () => 'never', { onTokenRejected: () => rejected++ }),
    ).rejects.toThrow('authorization request failed')
    expect(f.calls).toEqual(['stale', undefined])
    expect(f.transacts()).toBe(1)
    expect(rejected).toBe(1)
  })

  it('valid token: one authorize, no retry; a failure in the work step is not retried', async () => {
    const f = fake([() => ({ auth_token: 'same' }), () => ({ auth_token: 'unused' })])
    await expect(
      withAuthorizedWallet(f.transact, 'same', async () => {
        throw new Error('java.util.concurrent.CancellationException')
      }),
    ).rejects.toThrow('CancellationException')
    expect(f.calls).toEqual(['same'])
    expect(f.transacts()).toBe(1)
  })

  it('no stored token (connect) -> plain fresh authorize; an empty token counts as none', async () => {
    const f = fake([() => ({ auth_token: 't1' })])
    expect(await withAuthorizedWallet(f.transact, '', async (_w, s) => s.authToken)).toBe('t1')
    expect(f.calls).toEqual([undefined])
  })
})
