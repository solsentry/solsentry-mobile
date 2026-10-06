import { describe, expect, it } from 'vitest'
import { disconnectWallet, type Transact, type WalletSession } from '../src/wallet/mwa-session'

const SESSION: WalletSession = { address: 'Addr1111', authToken: 'tok', label: 'Seed Vault' }

/** Minimal stand-in for the provider's state: what the UI would render after each step. */
function store(initial: WalletSession | null) {
  let session = initial
  return {
    get: () => session,
    clear: () => {
      session = null
    },
  }
}

function fakeTransact(deauth: (token: string) => Promise<void>) {
  const tokens: string[] = []
  const transact = (async (cb: (w: never) => unknown) =>
    cb({
      deauthorize: async (p: { auth_token: string }) => {
        tokens.push(p.auth_token)
        await deauth(p.auth_token)
      },
    } as never)) as Transact
  return { transact, tokens }
}

describe('Disconnect', () => {
  it('connected -> disconnected: local session cleared before the wallet answers, token revoked', async () => {
    const s = store(SESSION)
    let seenDuringDeauth: WalletSession | null | undefined
    const f = fakeTransact(async () => {
      seenDuringDeauth = s.get()
    })
    expect(await disconnectWallet(f.transact, s.get(), s.clear)).toBe(true)
    expect(s.get()).toBeNull()
    expect(seenDuringDeauth).toBeNull()
    expect(f.tokens).toEqual(['tok'])
  })

  it('deauthorize fails (wallet closed/cancelled) -> still disconnected, no throw', async () => {
    const s = store(SESSION)
    const f = fakeTransact(async () => {
      throw new Error('java.util.concurrent.CancellationException')
    })
    expect(await disconnectWallet(f.transact, s.get(), s.clear)).toBe(false)
    expect(s.get()).toBeNull()
  })

  it('transact itself fails (no wallet app) -> still disconnected, no throw', async () => {
    const s = store(SESSION)
    const broken = (async () => {
      throw Object.assign(new Error('no wallet'), { code: 'ERROR_WALLET_NOT_FOUND' })
    }) as Transact
    expect(await disconnectWallet(broken, s.get(), s.clear)).toBe(false)
    expect(s.get()).toBeNull()
  })

  it('no auth token (already rejected) -> local clear only, wallet not opened', async () => {
    const s = store({ ...SESSION, authToken: '' })
    let opened = 0
    const t = (async () => {
      opened++
    }) as unknown as Transact
    expect(await disconnectWallet(t, s.get(), s.clear)).toBe(false)
    expect(s.get()).toBeNull()
    expect(opened).toBe(0)
  })
})
