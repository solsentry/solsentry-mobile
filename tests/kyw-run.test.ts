import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fetchWithTimeout } from '../src/guard/fetch-timeout'
import { parseTask, shortId } from '../src/kyw-core'
import { resolveEndpoint, type Endpoint } from '../src/kyw/providers'
import { runOneTask, type RunDeps } from '../src/kyw/run'

const DIR = join(__dirname, 'fixtures', 'kyw_tx_core')
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  vectors: { name: string; file: string; fact_digest: string | null; synthetic?: boolean }[]
}
const vector = manifest.vectors.find((v) => !v.synthetic && v.fact_digest)!
const RAW = readFileSync(join(DIR, vector.file), 'utf8')
const SIGNATURE = (JSON.parse(RAW) as { result: { transaction: { signatures: string[] } } }).result.transaction.signatures[0]
const API = 'https://api.example.test'
const SECRET = 'abcd1234-secret-key-0000'

const TASK = {
  task_id: 'task-1',
  fact_type: 'tx.core',
  spec_version: '0',
  params: { signature: SIGNATURE },
  rule: null,
  read: { method: 'getTransaction', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
  deadline: '2030-01-01T00:00:00Z',
}

interface Call {
  url: string
  body: string | null
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

/** A SolSentry server that answers like the v0 routes, plus an RPC that returns `rpc`. */
function world(overrides: { task?: Handler; rpc?: Handler; result?: Handler } = {}) {
  const calls: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : null })
    if (url === `${API}/v1/kyw/task`) return (overrides.task ?? (() => json(TASK)))(url, init)
    if (url === `${API}/v1/kyw/result`) {
      if (overrides.result) return overrides.result(url, init)
      const sent = JSON.parse(String(init?.body)) as { status: string; fact_digest: string | null; unknown_reason: string | null }
      if (sent.status === 'unknown') return json({ verdict: 'unknown', reason: sent.unknown_reason })
      return sent.fact_digest === vector.fact_digest
        ? json({ verdict: 'accepted', reference: 'solsentry', message: "Your result matched SolSentry's reference read." })
        : json({ verdict: 'diverged', reference: 'solsentry' })
    }
    return (overrides.rpc ?? (() => new Response(RAW, { status: 200 })))(url, init)
  }) as typeof fetch
  return { calls, fetchFn }
}

function deps(fetchFn: typeof fetch, endpoint: Endpoint, provider: RunDeps['provider'] = 'solsentry'): RunDeps {
  if (!endpoint.ok) throw new Error(endpoint.problem)
  let t = 1_700_000_000_000
  return { fetch: fetchFn, apiBase: API, provider, endpoint, clientVersion: '0.1.0', now: () => (t += 7) }
}

const PROXY = resolveEndpoint('solsentry', '', 'api.example.test')
const HELIUS = resolveEndpoint('helius', SECRET, 'api.example.test')

describe('runOneTask', () => {
  it('default RPC: reads through the SolSentry server and is accepted', async () => {
    const w = world()
    const seen: string[] = []
    const out = await runOneTask({ ...deps(w.fetchFn, PROXY), onReading: (s) => seen.push(s) })
    expect(out.record).toMatchObject({ id: 'task-1', verdict: 'accepted', reason: null, short: shortId(SIGNATURE), host: 'api.example.test' })
    expect(out.record.bytes).toBe(Buffer.byteLength(RAW))
    expect(out.backoff).toBe(false)
    expect(seen).toEqual([shortId(SIGNATURE)])
    expect(w.calls.map((c) => c.url)).toEqual([`${API}/v1/kyw/task`, `${API}/v1/kyw/rpc`, `${API}/v1/kyw/result`])
    expect(JSON.parse(w.calls[1].body!)).toEqual({
      task_id: 'task-1',
      method: 'getTransaction',
      params: [SIGNATURE, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }],
    })
    const sent = JSON.parse(w.calls[2].body!)
    expect(sent).toMatchObject({
      task_id: 'task-1',
      fact_type: 'tx.core',
      spec_version: '0',
      status: 'ok',
      unknown_reason: null,
      fact_digest: vector.fact_digest,
      signatures: [SIGNATURE],
      rpc_host: 'api.example.test',
      client: { kind: 'android', version: '0.1.0' },
      device_key_id: null,
      device_sig: null,
    })
    expect(sent.fact).toBeUndefined()
    expect(Number.isInteger(sent.metrics.bytes) && Number.isInteger(sent.metrics.ms)).toBe(true)
    expect(Date.parse(sent.read_at.end)).toBeGreaterThanOrEqual(Date.parse(sent.read_at.start))
  })

  it('own key: the read goes to the provider and the key reaches nobody else', async () => {
    const w = world()
    const out = await runOneTask(deps(w.fetchFn, HELIUS, 'helius'))
    expect(out.record).toMatchObject({ verdict: 'accepted', host: 'mainnet.helius-rpc.com', provider: 'helius' })
    expect(w.calls[1].url).toBe(`https://mainnet.helius-rpc.com/?api-key=${SECRET}`)
    expect(JSON.parse(w.calls[1].body!)).toMatchObject({ jsonrpc: '2.0', method: 'getTransaction' })
    for (const call of [w.calls[0], w.calls[2]]) {
      expect(call.url).not.toContain(SECRET)
      expect(call.body ?? '').not.toContain(SECRET)
    }
    expect(JSON.stringify(out.record)).not.toContain(SECRET)
    expect(JSON.parse(w.calls[2].body!).rpc_host).toBe('mainnet.helius-rpc.com')
  })

  it('a different transaction body diverges', async () => {
    const other = manifest.vectors.find((v) => !v.synthetic && v.fact_digest && v.name !== vector.name)!
    const w = world({ rpc: () => new Response(readFileSync(join(DIR, other.file), 'utf8')) })
    const out = await runOneTask(deps(w.fetchFn, PROXY))
    expect(out.record.verdict).toBe('diverged')
  })

  it('no network (airplane mode): unknown/rpc_error, never a match', async () => {
    const out = await runOneTask(
      deps((async () => Promise.reject(new TypeError('Network request failed'))) as typeof fetch, PROXY),
    )
    expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'rpc_error', short: '' })
    expect(out.backoff).toBe(true)
  })

  it('network drops after the task: the read is unknown/rpc_error and the result cannot be sent', async () => {
    const w = world({
      rpc: () => Promise.reject(new TypeError('Network request failed')),
      result: () => Promise.reject(new TypeError('Network request failed')),
    })
    const out = await runOneTask(deps(w.fetchFn, PROXY))
    expect(out.record).toMatchObject({ id: 'task-1', verdict: 'unknown', reason: 'submit_failed' })
    expect(JSON.parse(w.calls[2].body!)).toMatchObject({ status: 'unknown', unknown_reason: 'rpc_error', fact_digest: null })
    expect(out.backoff).toBe(true)
  })

  it('RPC answers 429: rate_limited is reported and the caller is told to wait', async () => {
    const w = world({ rpc: () => new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '17' } }) })
    const out = await runOneTask(deps(w.fetchFn, HELIUS, 'helius'))
    expect(JSON.parse(w.calls[2].body!)).toMatchObject({ status: 'unknown', unknown_reason: 'rate_limited' })
    expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'rate_limited' })
    expect(out).toMatchObject({ backoff: true, retryAfterS: 17 })
  })

  it('JSON-RPC 429 error inside an HTTP 200 is rate_limited too', async () => {
    const w = world({ rpc: () => json({ jsonrpc: '2.0', error: { code: 429, message: 'Too many requests' }, id: 1 }) })
    const out = await runOneTask(deps(w.fetchFn, HELIUS, 'helius'))
    expect(out.record.reason).toBe('rate_limited')
    expect(out.backoff).toBe(true)
  })

  it('the task endpoint answers 429: nothing is read', async () => {
    const w = world({ task: () => json({ error: 'rate_limited' }, 429, { 'Retry-After': '9' }) })
    const out = await runOneTask(deps(w.fetchFn, PROXY))
    expect(w.calls).toHaveLength(1)
    expect(out).toMatchObject({ backoff: true, retryAfterS: 9 })
    expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'rate_limited' })
  })

  it('an HTML error page from the RPC is rpc_error, not invalid_response', async () => {
    const w = world({ rpc: () => new Response('<html>502</html>', { status: 502 }) })
    await runOneTask(deps(w.fetchFn, PROXY))
    expect(JSON.parse(w.calls[2].body!).unknown_reason).toBe('rpc_error')
  })

  it('garbage with HTTP 200 is invalid_response', async () => {
    const w = world({ rpc: () => new Response('{"result":{"slot":1}}') })
    await runOneTask(deps(w.fetchFn, PROXY))
    expect(JSON.parse(w.calls[2].body!)).toMatchObject({ status: 'unknown', unknown_reason: 'invalid_response' })
  })

  it('a null result is not_available', async () => {
    const w = world({ rpc: () => json({ jsonrpc: '2.0', result: null, id: 1 }) })
    const out = await runOneTask(deps(w.fetchFn, PROXY))
    expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'not_available' })
    expect(out.backoff).toBe(false)
  })

  it('a read that stalls past the deadline is unknown/timeout', async () => {
    const w = world({ rpc: () => new Promise<Response>(() => {}) })
    const out = await runOneTask(deps(fetchWithTimeout(w.fetchFn, 30, 'Request'), PROXY))
    expect(JSON.parse(w.calls[2].body!).unknown_reason).toBe('timeout')
    expect(out.record.reason).toBe('timeout')
  })

  it('keeps the reason the server gives (expired task)', async () => {
    const w = world({ result: () => json({ verdict: 'unknown', reason: 'expired' }) })
    const out = await runOneTask(deps(w.fetchFn, PROXY))
    expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'expired' })
  })

  it('a result the server refuses, or an answer without a verdict, is submit_failed', async () => {
    for (const result of [() => json({ error: 'invalid_rpc_host' }, 400), () => json({ ok: true })]) {
      const out = await runOneTask(deps(world({ result }).fetchFn, PROXY))
      expect(out.record).toMatchObject({ verdict: 'unknown', reason: 'submit_failed' })
    }
  })

  it('an empty pool or a task it cannot do ends without a read', async () => {
    const empty = world({ task: () => json({ error: 'pool_empty' }, 503) })
    expect((await runOneTask(deps(empty.fetchFn, PROXY))).record.reason).toBe('no_task')
    const other = world({ task: () => json({ ...TASK, spec_version: '1' }) })
    expect((await runOneTask(deps(other.fetchFn, PROXY))).record.reason).toBe('unsupported_task')
    expect(other.calls).toHaveLength(1)
  })
})

describe('parseTask', () => {
  it('accepts the v0 task and nothing else', () => {
    expect(parseTask(TASK)).toEqual({ task_id: 'task-1', signature: SIGNATURE, deadline: TASK.deadline })
    expect(parseTask({ ...TASK, fact_type: 'wallet.core' })).toBeNull()
    expect(parseTask({ ...TASK, rule: { x: 1 } })).toBeNull()
    expect(parseTask({ ...TASK, read: { ...TASK.read, commitment: 'confirmed' } })).toBeNull()
    expect(parseTask({ ...TASK, read: { ...TASK.read, extra: 1 } })).toBeNull()
    expect(parseTask({ ...TASK, params: { signature: 'not base58 0OIl' } })).toBeNull()
    expect(parseTask(null)).toBeNull()
  })
})

describe('resolveEndpoint', () => {
  it('builds provider URLs and reports only a host', () => {
    expect(resolveEndpoint('solami', SECRET, 'h')).toEqual({
      ok: true,
      kind: 'direct',
      url: `https://rpc.solami.dev/solana?api-key=${SECRET}`,
      host: 'rpc.solami.dev',
    })
    const qn = resolveEndpoint('quicknode', ' https://my-name-123.solana-mainnet.quiknode.pro/0123456789abcdef/ ', 'h')
    expect(qn).toMatchObject({ ok: true, host: 'solana-mainnet.quiknode.pro' })
    expect(qn.ok && qn.host).not.toContain('my-name')
  })

  it('refuses a missing or malformed secret', () => {
    expect(resolveEndpoint('helius', '', 'h').ok).toBe(false)
    expect(resolveEndpoint('helius', 'a b&c=d', 'h').ok).toBe(false)
    expect(resolveEndpoint('quicknode', 'http://x.solana-mainnet.quiknode.pro/t/', 'h').ok).toBe(false)
    expect(resolveEndpoint('quicknode', 'https://evil.example/x.quiknode.pro/', 'h').ok).toBe(false)
    expect(resolveEndpoint('quicknode', 'https://x.quiknode.pro.evil.example/t/', 'h').ok).toBe(false)
  })
})
