import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-ins for AsyncStorage and the Keystore, with writes that can be held open.
const disk = new Map<string, string>()
const keystore = new Map<string, string>()
let holdSecureWrites: Promise<void> | null = null

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => disk.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void disk.set(k, v)),
    removeItem: vi.fn(async (k: string) => void disk.delete(k)),
  },
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k: string) => keystore.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    if (holdSecureWrites) await holdSecureWrites
    keystore.set(k, v)
  }),
  deleteItemAsync: vi.fn(async (k: string) => void keystore.delete(k)),
}))

async function freshStore() {
  vi.resetModules()
  const store = await import('../src/kyw/store')
  await store.load()
  return store
}

beforeEach(() => {
  disk.clear()
  keystore.clear()
  holdSecureWrites = null
})

describe('key storage', () => {
  it('a slow "save" that finishes after "save off" does not leave the key stored', async () => {
    const store = await freshStore()
    await store.setSecret('helius', 'key-aaaaaaaa')
    let release!: () => void
    holdSecureWrites = new Promise((r) => (release = r))
    const on = store.updateSettings({ saveKey: true })
    const off = store.updateSettings({ saveKey: false })
    holdSecureWrites = null
    release()
    await Promise.all([on, off])
    expect(store.getState().settings.saveKey).toBe(false)
    expect([...keystore.keys()]).toEqual([])
  })

  it('with saving off, a key left in the Keystore by a failed delete is removed on the next start', async () => {
    keystore.set('solsentry-kyw.rpc.helius', 'stale-key-123')
    await freshStore()
    expect(keystore.size).toBe(0)
  })

  it('with saving on, the key survives a restart', async () => {
    const first = await freshStore()
    await first.updateSettings({ saveKey: true })
    await first.setSecret('helius', 'key-bbbbbbbb')
    const second = await freshStore()
    expect(second.getState().secrets.helius).toBe('key-bbbbbbbb')
  })

  it('changing the key or URL drops the capability report of the old endpoint', async () => {
    const store = await freshStore()
    await store.setSecret('quicknode', 'https://a.solana-mainnet.quiknode.pro/tokenA/')
    await store.recordProbeReport('quicknode', {
      probe_version: '0',
      rpc_host: 'solana-mainnet.quiknode.pro',
      measured_at: new Date().toISOString(),
      capabilities: {
        C1: { class: 'full', ms: 1 }, C2: { class: 'full', ms: 1 }, C3: { class: 'full', ms: 1 },
        C4: { class: 'full', ms: 1 }, C5: { class: 'full', ms: 1 }, C6: { min_interval_ms: 250 },
      },
      client: { kind: 'android', version: '0.1.0' },
    })
    expect(store.getState().probeReports.quicknode).toBeDefined()
    await store.setSecret('quicknode', 'https://a.solana-mainnet.quiknode.pro/tokenA/')
    expect(store.getState().probeReports.quicknode).toBeDefined()
    await store.setSecret('quicknode', 'https://b.solana-mainnet.quiknode.pro/tokenB/')
    expect(store.getState().probeReports.quicknode).toBeUndefined()
    expect(disk.get('solsentry-kyw/probe/v1')).not.toContain('quicknode')
  })
})

describe('stored history that was tampered with', () => {
  it('a record with reason "__proto__" is dropped, and the sentence is always a string', async () => {
    const { parsePersisted } = await import('../src/kyw/history')
    const { resultSentence } = await import('../src/kyw/copy')
    const bad = { id: 'x', at: 1, short: '', verdict: 'unknown', reason: '__proto__', provider: 'solsentry', host: 'h', ms: 1, bytes: 1 }
    expect(parsePersisted(JSON.stringify({ records: [bad], counters: {} })).records).toEqual([])
    for (const reason of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(typeof resultSentence({ verdict: 'unknown', reason })).toBe('string')
      expect(resultSentence({ verdict: 'unknown', reason })).toBe('No result for this task.')
    }
  })
})
