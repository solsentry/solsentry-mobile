import { describe, expect, it } from 'vitest'

import { PAGE_LIMIT, PROBE_TTL_MS, parseProbeTargets, probeIsStale, runProbe, type ProbeDeps, type ProbeTargets } from '../src/kyw/probe'

const SIG = (c: string) => c.repeat(88)
const TARGETS: ProbeTargets = {
  probe_version: '0',
  recent_signature: SIG('2'),
  archival_signature: SIG('3'),
  page_address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  page_before_signature: SIG('4'),
  account: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  read: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
}
const SECRET = 'secret-key-1234567890'
const URL_WITH_KEY = `https://rpc.example.test/?api-key=${SECRET}`

type Reply = { status?: number; body?: unknown; text?: string; throws?: Error }
type Rpc = (method: string, params: unknown[], n: number) => Reply

function harness(rpc: Rpc) {
  const calls: { method: string; params: unknown[] }[] = []
  const sleeps: number[] = []
  let t = 1_800_000_000_000
  const deps: ProbeDeps = {
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
      calls.push(req)
      t += 100
      const r = rpc(req.method, req.params, calls.filter((c) => c.method === req.method).length)
      if (r.throws) throw r.throws
      return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200 })
    }) as typeof fetch,
    url: URL_WITH_KEY,
    host: 'rpc.example.test',
    targets: TARGETS,
    clientVersion: '0.1.0',
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  return { deps, calls, sleeps }
}

const ok = (result: unknown): Reply => ({ body: { jsonrpc: '2.0', id: 1, result } })
const page = (n: number) => ok(Array.from({ length: n }, (_, i) => ({ signature: `s${i}` })))

const healthy: Rpc = (method, params) => {
  if (method === 'getSignaturesForAddress') return page((params[1] as { limit: number }).limit)
  if (method === 'getAccountInfo') return ok({ context: { slot: 1 }, value: { lamports: 1, data: ['', 'base64'] } })
  return ok({ slot: 1 })
}

describe('capability probe', () => {
  it('a full endpoint: every class full, the shortest pace, 8 calls, nothing secret in the report', async () => {
    const h = harness(healthy)
    const report = await runProbe(h.deps)
    expect(report.capabilities).toEqual({
      C1: { class: 'full', ms: 100 },
      C2: { class: 'full', ms: 100 },
      C3: { class: 'full', ms: 100 },
      C4: { class: 'full', ms: 100 },
      C5: { class: 'full', ms: 100 },
      C6: { min_interval_ms: 250 },
    })
    expect(report).toMatchObject({ probe_version: '0', rpc_host: 'rpc.example.test', client: { kind: 'android', version: '0.1.0' } })
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(h.calls.map((c) => c.method)).toEqual([
      'getTransaction', 'getTransaction', 'getSignaturesForAddress', 'getSignaturesForAddress', 'getAccountInfo',
      'getTransaction', 'getTransaction', 'getTransaction',
    ])
    expect(h.calls[0].params).toEqual([TARGETS.recent_signature, TARGETS.read])
    expect(h.calls[2].params).toEqual([TARGETS.page_address, { limit: PAGE_LIMIT }])
    expect(h.calls[3].params).toEqual([TARGETS.page_address, { limit: 10, before: TARGETS.page_before_signature }])
    expect(h.calls[4].params).toEqual([TARGETS.account, { encoding: 'base64' }])
    expect(h.calls[7].params).toEqual([TARGETS.recent_signature, TARGETS.read])
    expect(h.sleeps).toEqual([250, 250, 250])
  })

  it('a null result is "not here", an error is "none", and neither is confused with the other', async () => {
    const h = harness((method, params) => {
      if (method === 'getTransaction' && params[0] === TARGETS.archival_signature) return ok(null)
      if (method === 'getAccountInfo') return { body: { error: { code: -32601, message: 'Method not found' } } }
      return healthy(method, params, 0)
    })
    const { capabilities: c } = await runProbe(h.deps)
    expect(c.C1.class).toBe('full')
    expect(c.C2).toEqual({ class: 'none', reason: 'not_available' })
    expect(c.C5).toEqual({ class: 'none', reason: 'rpc_error' })
  })

  it('a short first page is limited with its size; a short old page is still full; an empty page is none', async () => {
    const h = harness((method, params) => {
      if (method === 'getSignaturesForAddress') return page((params[1] as { before?: string }).before ? 3 : 314)
      return healthy(method, params, 0)
    })
    const { capabilities: c } = await runProbe(h.deps)
    expect(c.C3).toEqual({ class: 'limited', page_size: 314, ms: 100 })
    expect(c.C4).toEqual({ class: 'full', ms: 100 })
    const empty = harness((method, params) => (method === 'getSignaturesForAddress' ? page(0) : healthy(method, params, 0)))
    const e = (await runProbe(empty.deps)).capabilities
    expect(e.C3).toEqual({ class: 'none', reason: 'empty_page' })
    expect(e.C4).toEqual({ class: 'none', reason: 'empty_page' })
  })

  it('rate limits and version refusals get their own class, in that order', async () => {
    const h = harness((method, params) => {
      if (method === 'getTransaction' && params[0] === TARGETS.recent_signature) return { status: 429, text: 'slow down' }
      if (method === 'getTransaction') return { body: { error: { code: -32015, message: 'Transaction version (1) is not supported' } } }
      if (method === 'getSignaturesForAddress') return { body: { error: { code: -32005, message: 'Rate limit exceeded for this version of the plan' } } }
      if (method === 'getAccountInfo') return { status: 503, text: '<html>down</html>' }
      return healthy(method, params, 0)
    })
    const { capabilities: c } = await runProbe(h.deps)
    expect(c.C1).toEqual({ class: 'rate_limited', reason: 'rate_limited' })
    expect(c.C2).toEqual({ class: 'version', reason: 'version' })
    expect(c.C3).toEqual({ class: 'rate_limited', reason: 'rate_limited' })
    expect(c.C5).toEqual({ class: 'none', reason: 'http_error' })
  })

  it('timeouts and network failures are none with a fixed reason code, never the error text', async () => {
    const h = harness((method) =>
      method === 'getTransaction'
        ? { throws: new Error(`Request timed out after 10 s (${URL_WITH_KEY})`) }
        : { throws: new TypeError(`Network request failed: ${URL_WITH_KEY}`) },
    )
    const report = await runProbe(h.deps)
    expect(report.capabilities.C1).toEqual({ class: 'none', reason: 'timeout' })
    expect(report.capabilities.C3).toEqual({ class: 'none', reason: 'rpc_error' })
    expect(report.capabilities.C6).toEqual({ min_interval_ms: null })
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('finds the shortest pace without a 429, and null when every pace is limited', async () => {
    // getTransaction calls 1-2 are C1 and C2. In the 250 ms burst (calls 3-5) the last one is limited;
    // the 600 ms burst (calls 6-8) is clean.
    const h = harness((method, params, n) => (method === 'getTransaction' && n === 5 ? { status: 429, text: '' } : healthy(method, params, n)))
    expect((await runProbe(h.deps)).capabilities.C6).toEqual({ min_interval_ms: 600 })
    expect(h.calls).toHaveLength(11)
    const never = harness((method, params, n) =>
      method === 'getTransaction' && n > 2 ? { body: { error: { code: 429, message: 'Too many requests' } } } : healthy(method, params, n),
    )
    expect((await runProbe(never.deps)).capabilities.C6).toEqual({ min_interval_ms: null })
    // A burst stops at its first 429: 5 + 1 + 1 + 1.
    expect(never.calls).toHaveLength(8)
  })

  it('a pace burst that fails for another reason is not a rate limit', async () => {
    const h = harness((method, params, n) => (method === 'getTransaction' && n > 2 ? ok(null) : healthy(method, params, n)))
    expect((await runProbe(h.deps)).capabilities.C6).toEqual({ min_interval_ms: 250 })
  })
})

describe('account state', () => {
  it('an account the endpoint does not have is not_available, and a bare result is unusable', async () => {
    const missing = harness((method, params, n) =>
      method === 'getAccountInfo' ? ok({ context: { slot: 1 }, value: null }) : healthy(method, params, n),
    )
    expect((await runProbe(missing.deps)).capabilities.C5).toEqual({ class: 'none', reason: 'not_available' })
    const bare = harness((method, params, n) => (method === 'getAccountInfo' ? ok({ slot: 1 }) : healthy(method, params, n)))
    expect((await runProbe(bare.deps)).capabilities.C5).toEqual({ class: 'none', reason: 'invalid_response' })
  })
})

describe('probe targets and validity', () => {
  it('accepts the v0 targets and refuses any other read options', () => {
    expect(parseProbeTargets(TARGETS)).toEqual(TARGETS)
    expect(parseProbeTargets({ ...TARGETS, probe_version: '1' })).toBeNull()
    expect(parseProbeTargets({ ...TARGETS, read: { ...TARGETS.read, maxSupportedTransactionVersion: 0 } })).toBeNull()
    expect(parseProbeTargets({ ...TARGETS, account: 'https://evil.example' })).toBeNull()
    expect(parseProbeTargets(null)).toBeNull()
  })

  it('a report expires after 6 hours, on another host, or when its date is unusable', async () => {
    const h = harness(healthy)
    const report = await runProbe(h.deps)
    const at = Date.parse(report.measured_at)
    expect(probeIsStale(report, 'rpc.example.test', at + 1000)).toBe(false)
    expect(probeIsStale(report, 'rpc.example.test', at + PROBE_TTL_MS + 1)).toBe(true)
    expect(probeIsStale(report, 'other.example.test', at + 1000)).toBe(true)
    expect(probeIsStale({ ...report, measured_at: 'yesterday' }, 'rpc.example.test', at)).toBe(true)
    expect(probeIsStale(null, 'rpc.example.test', at)).toBe(true)
  })
})
