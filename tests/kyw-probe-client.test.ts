import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { probeCapabilityText, probePaceText, probeReportLines } from '../src/kyw/copy'
import { PROBE_TTL_MS, parseProbeTargets, probeIsStale, type ProbeReport, type ProbeTargets } from '../src/kyw/probe'
import { chosenRpcProbeIsStale, fetchProbeTargets, probeChosenRpc } from '../src/kyw/probe-client'
import { resolveEndpoint, type ProviderId } from '../src/kyw/providers'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value) }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key) }),
  },
}))
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }))

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const API = 'https://api.example.test'
const SECRET = 'private-token-12345678'
const SECRET_URL = `https://private-endpoint.solana-mainnet.quiknode.pro/${SECRET}/`
const AT = 1_800_000_000_000
const PROBE_KEY = 'solsentry-kyw/probe/v1'
const TARGETS: ProbeTargets = {
  probe_version: '0',
  recent_signature: '2'.repeat(88),
  archival_signature: '3'.repeat(88),
  page_address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  page_before_signature: '3'.repeat(88),
  account: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  read: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
}

function harness(provider: ProviderId = 'quicknode', secret = SECRET_URL) {
  const fetch = vi.fn<FetchFn>(async (_input, init) => {
    if (init?.method === 'GET') return Response.json(TARGETS)
    const { method, params } = JSON.parse(String(init?.body))
    return Response.json({ result: method === 'getSignaturesForAddress'
      ? Array.from({ length: params[1].limit }, () => ({ signature: 'public' }))
      : method === 'getAccountInfo' ? { context: { slot: 1 }, value: { lamports: 1 } } : { slot: 1 } })
  })
  return { fetch, apiBase: API, provider, secret, clientVersion: '0.1.0', now: () => AT, sleep: async () => {} }
}

async function report(): Promise<ProbeReport> {
  const result = await probeChosenRpc(harness())
  if (!result.ok || result.kind !== 'report') throw new Error('Expected a report')
  return result.report
}

beforeEach(() => {
  storage.clear()
  vi.resetModules()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

describe('probe targets client', () => {
  it('fetches and parses targets from the configured API', async () => {
    const h = harness()
    expect(await fetchProbeTargets(h.fetch, `${API}/`)).toEqual({ ok: true, targets: TARGETS })
    expect(h.fetch).toHaveBeenCalledWith(`${API}/v1/kyw/probe`, expect.objectContaining({ method: 'GET' }))
  })

  it.each([404, 429, 503])('returns a fixed HTTP code for %i', async (status) => {
    const fetch = vi.fn<FetchFn>(async () => new Response(SECRET_URL, { status }))
    expect(await fetchProbeTargets(fetch, API)).toEqual({ ok: false, problem: `http_${status}` })
  })

  it('returns a fixed network code without exception text', async () => {
    const fetch = vi.fn<FetchFn>().mockRejectedValue(new Error(SECRET_URL))
    expect(await fetchProbeTargets(fetch, API)).toEqual({ ok: false, problem: 'network' })
  })

  it.each(['{oops', 'null', '[]', '{}', JSON.stringify({ ...TARGETS, probe_version: '9' })])('rejects malformed targets: %s', async (body) => {
    const fetch = vi.fn<FetchFn>(async () => new Response(body))
    expect(await fetchProbeTargets(fetch, API)).toEqual({ ok: false, problem: 'no_targets' })
  })

  it('times out even when headers arrive but the body stalls', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<FetchFn>(async () => ({ text: () => new Promise(() => {}) }) as Response)
    const pending = fetchProbeTargets(fetch, API)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({ ok: false, problem: 'network' })
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
})

describe('chosen RPC probe', () => {
  it('does not fetch anything for the task-only proxy', async () => {
    const h = harness('solsentry', '')
    expect(await probeChosenRpc(h)).toEqual({ ok: true, kind: 'not_applicable' })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each(['helius', 'quicknode', 'solami'] as const)('returns the endpoint problem without fetching for missing %s credentials', async (provider) => {
    const h = harness(provider, '')
    expect(await probeChosenRpc(h)).toEqual(resolveEndpoint(provider, '', ''))
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('does not contact an RPC when targets cannot be loaded', async () => {
    const h = harness()
    h.fetch.mockResolvedValue(new Response('', { status: 404 }))
    expect(await probeChosenRpc(h)).toEqual({ ok: false, problem: 'http_404' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['helius', 'quicknode', 'solami'] as const)('uses resolveEndpoint for %s and returns only its reportable host', async (provider) => {
    const h = harness(provider, provider === 'quicknode' ? SECRET_URL : SECRET)
    const endpoint = resolveEndpoint(provider, h.secret, '')
    if (!endpoint.ok || endpoint.kind !== 'direct') throw new Error('Expected direct endpoint')
    const result = await probeChosenRpc(h)
    expect(result).toMatchObject({ ok: true, kind: 'report', report: { rpc_host: endpoint.host } })
    expect(h.fetch).toHaveBeenCalledTimes(9)
    expect(h.fetch.mock.calls.slice(1).every(([url, init]) => url === endpoint.url && init?.method === 'POST')).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(endpoint.url)
    expect(JSON.stringify(result)).not.toContain('private-endpoint')
  })

  it('strips secrets echoed in RPC errors', async () => {
    const h = harness()
    h.fetch.mockImplementation(async (_url, init) => init?.method === 'GET'
      ? Response.json(TARGETS) : Response.json({ error: { code: -1, message: SECRET_URL } }))
    const result = await probeChosenRpc(h)
    expect(result).toMatchObject({ report: { capabilities: { C1: { class: 'none', reason: 'rpc_error' } } } })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('applies the 10 second body deadline to RPC reads', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.fetch.mockImplementationOnce(async () => Response.json(TARGETS))
      .mockImplementationOnce(async () => ({ text: () => new Promise(() => {}) }) as Response)
    const pending = probeChosenRpc(h)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ report: { capabilities: { C1: { class: 'none', reason: 'timeout' } } } })
  })

  it('wires chosen-host freshness to probeIsStale, including expiry and unusable credentials', async () => {
    const r = await report()
    for (const now of [AT, AT + PROBE_TTL_MS, AT + PROBE_TTL_MS + 1, AT - 60_001]) {
      expect(chosenRpcProbeIsStale(r, 'quicknode', SECRET_URL, now)).toBe(probeIsStale(r, r.rpc_host, now))
    }
    expect(chosenRpcProbeIsStale(r, 'helius', SECRET, AT)).toBe(true)
    expect(chosenRpcProbeIsStale(r, 'quicknode', '', AT)).toBe(true)
    expect(chosenRpcProbeIsStale(null, 'quicknode', SECRET_URL, AT)).toBe(true)
  })
})

describe('probe report storage', () => {
  it('round-trips per-provider reports and loads them with the rest of the state', async () => {
    const r = await report()
    const store = await import('../src/kyw/store')
    await store.recordProbeReport('quicknode', r)
    const helius = { ...r, rpc_host: 'mainnet.helius-rpc.com' }
    await store.recordProbeReport('helius', helius)
    const updated = { ...r, capabilities: { ...r.capabilities, C3: { class: 'limited' as const, page_size: 314 } } }
    await store.recordProbeReport('quicknode', updated)
    const expected = { quicknode: updated, helius }
    expect(store.parseProbeReports(storage.get(PROBE_KEY)!)).toEqual(expected)
    vi.resetModules()
    const reopened = await import('../src/kyw/store')
    await reopened.load()
    expect(reopened.getState()).toMatchObject({ loaded: true, probeReports: expected })
  })

  it.each([null, '', '{oops', 'null', '[]', '1', '{}', '{"quicknode":null}', '{"quicknode":{"capabilities":[]}}'])('drops garbage without throwing: %s', async (raw) => {
    const { parseProbeReports } = await import('../src/kyw/store')
    expect(parseProbeReports(raw)).toEqual({})
  })

  it('never persists a secret URL, including unexpected fields in a report', async () => {
    const r = await report()
    const { recordProbeReport, parseProbeReports, getState } = await import('../src/kyw/store')
    const extra = { ...r, url: SECRET_URL, secret: SECRET, capabilities: { ...r.capabilities, C1: { ...r.capabilities.C1, url: SECRET_URL } } }
    await recordProbeReport('quicknode', extra)
    const json = storage.get(PROBE_KEY)!
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain(SECRET_URL)
    expect(json).not.toContain('private-endpoint')
    expect(JSON.stringify(getState().probeReports)).toBe(json)
    expect(parseProbeReports(JSON.stringify({ quicknode: extra }))).toEqual({ quicknode: r })
    expect(parseProbeReports(JSON.stringify({ quicknode: { ...r, rpc_host: SECRET_URL } }))).toEqual({})
    expect(parseProbeReports(JSON.stringify({ quicknode: { ...r, capabilities: { ...r.capabilities, C1: { class: 'none', reason: SECRET_URL } } } }))).toEqual({})
    for (const C1 of [{ class: ['full'] }, { class: 'none', reason: ['rpc_error'] }]) {
      expect(parseProbeReports(JSON.stringify({ quicknode: { ...r, capabilities: { ...r.capabilities, C1 } } }))).toEqual({})
    }
  })

  it('retains reports in memory if storage fails', async () => {
    const r = await report()
    const storageModule = await import('@react-native-async-storage/async-storage')
    vi.mocked(storageModule.default.setItem).mockRejectedValueOnce(new Error('storage unavailable'))
    const store = await import('../src/kyw/store')
    await store.recordProbeReport('quicknode', r)
    expect(store.getState().probeReports.quicknode).toEqual(r)
  })
})

describe('probe presentation', () => {
  it('shows six named capabilities with measured page size and pace', async () => {
    const r = await report()
    r.capabilities.C3 = { class: 'limited', page_size: 314 }
    r.capabilities.C2 = { class: 'none', reason: 'not_available' }
    r.capabilities.C6.min_interval_ms = 600
    expect(probeReportLines(r)).toEqual([
      'Recent transactions: full',
      'Old transactions: not available (no data returned)',
      'Address history (first page): limited (314 entries per page)',
      'Old address history: full',
      'Account state: full',
      'Safe pace: 1 request every 600 ms',
    ])
    expect(probePaceText(null)).toBe('rate limited')
    expect(probeCapabilityText({ class: 'rate_limited' })).toBe('not available (rate limited)')
    expect(probeCapabilityText({ class: 'version' })).toBe('not available (transaction version unsupported)')
  })
})

describe('probe targets from production', () => {
  it('accepts a null page anchor, as integrations/kyw/probe.py sends by default', () => {
    expect(parseProbeTargets({ ...TARGETS, page_before_signature: null })?.page_before_signature).toBeNull()
    expect(parseProbeTargets({ ...TARGETS, page_before_signature: 'x' })).toBeNull()
  })
})
