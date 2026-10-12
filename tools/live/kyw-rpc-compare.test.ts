// Not part of `npm test`. Reads the 35 public vectors' transactions from many RPC endpoints with
// the app's own code and compares each digest with the manifest. Writes a JSON file for later
// comparison. Endpoint URLs may carry keys: only a label and a host are ever written.
//
//   KYW_COMPARE_OUT=/path/out.json [KYW_COMPARE_ENV=/path/.env] \
//     npx vitest run --config tools/live/vitest.config.ts kyw-rpc-compare
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { fetchWithTimeout } from '../../src/net/fetch-timeout'
import { READ_PARAMS, readOutcome, sha256Hex } from '../../src/kyw-core'

const out = process.env.KYW_COMPARE_OUT ?? ''
const DIR = join(__dirname, '../../tests/fixtures/kyw_tx_core')
const manifestBytes = readFileSync(join(DIR, 'manifest.json'))
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  vectors: { name: string; file: string; fact_digest: string | null; synthetic?: boolean }[]
}
const targets = manifest.vectors
  .filter((v) => !v.synthetic)
  .map((v) => {
    const body = JSON.parse(readFileSync(join(DIR, v.file), 'utf8')) as {
      result: { slot: number; blockTime: number | null; transaction: { signatures: string[] } }
    }
    return { name: v.name, digest: v.fact_digest, signature: body.result.transaction.signatures[0], blockTime: body.result.blockTime }
  })

function envFile(): Record<string, string> {
  const path = process.env.KYW_COMPARE_ENV
  if (!path) return {}
  const vars: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return vars
}
const env = envFile()

interface Endpoint {
  label: string
  access: 'no key' | 'key'
  url: string | undefined
}

const keyed = (label: string, url: string | undefined): Endpoint => ({ label, access: 'key', url })
const endpoints: Endpoint[] = [
  { label: 'solana-public', access: 'no key', url: 'https://api.mainnet-beta.solana.com' },
  { label: 'publicnode', access: 'no key', url: 'https://solana-rpc.publicnode.com' },
  { label: 'drpc-public', access: 'no key', url: 'https://solana.drpc.org' },
  { label: 'onfinality-public', access: 'no key', url: 'https://solana.api.onfinality.io/public' },
  { label: 'omnia-public', access: 'no key', url: 'https://endpoints.omniatech.io/v1/sol/mainnet/public' },
  { label: 'tatum-public', access: 'no key', url: 'https://solana-mainnet.gateway.tatum.io' },
  { label: 'leorpc-public', access: 'no key', url: 'https://solana.leorpc.com/?api_key=FREE' },
  { label: 'ankr-public', access: 'no key', url: 'https://rpc.ankr.com/solana' },
  keyed('helius', env.HELIUS_API_KEY_2 && `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY_2}`),
  keyed('solami', (env.SOLAMI_API_KEY ?? process.env.KYW_COMPARE_SOLAMI_KEY) && `https://rpc.solami.dev/solana?api-key=${env.SOLAMI_API_KEY ?? process.env.KYW_COMPARE_SOLAMI_KEY}`),
  keyed('quicknode', env.QUICKNODE_DAS_URL),
  keyed('alchemy', env.ALCHEMY_RPC_URL_1),
  keyed('chainstack', env.CHAINSTACK_RPC_URL),
  keyed('rpcfast', env.RPCFAST_RPC_URL_1),
  keyed('fluxrpc', env.FLUXRPC_URL),
]

interface Row {
  http: number | null
  status: 'ok' | 'unknown'
  reason: string | null
  match: boolean | null
  ms: number
  bytes: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function measure(endpoint: Endpoint) {
  const url = endpoint.url!
  const host = new URL(url).hostname
  const timed = fetchWithTimeout(fetch, 10_000, 'Request')
  const rows = []
  for (const t of targets) {
    const started = Date.now()
    let row: Row
    try {
      const res = await timed(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'solsentry-kyw-compare/0.1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [t.signature, { ...READ_PARAMS }] }),
      })
      const text = await res.text()
      const ms = Date.now() - started
      const o = res.status === 429 ? null : readOutcome(text)
      const reason =
        res.status === 429
          ? 'rate_limited'
          : !res.ok && o?.unknownReason === 'invalid_response'
            ? 'rpc_error'
            : (o?.unknownReason ?? null)
      row = {
        http: res.status,
        status: o?.status === 'ok' ? 'ok' : 'unknown',
        reason,
        match: o?.status === 'ok' ? o.factDigest === t.digest : null,
        ms,
        bytes: Buffer.byteLength(text),
      }
    } catch (e) {
      row = {
        http: null,
        status: 'unknown',
        reason: e instanceof Error && /timed out/.test(e.message) ? 'timeout' : 'rpc_error',
        match: null,
        ms: Date.now() - started,
        bytes: 0,
      }
    }
    rows.push({ vector: t.name, year: t.blockTime ? new Date(t.blockTime * 1000).getUTCFullYear() : null, ...row })
    await sleep(row.reason === 'rate_limited' ? 2500 : 450)
  }
  const ok = rows.filter((r) => r.status === 'ok')
  const reasons: Record<string, number> = {}
  for (const r of rows) if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
  const old = rows.filter((r) => r.year !== null && r.year <= 2024)
  const ms = ok.map((r) => r.ms as number).sort((a, b) => a - b)
  return {
    label: endpoint.label,
    access: endpoint.access,
    host,
    total: rows.length,
    ok: ok.length,
    matched: ok.filter((r) => r.match === true).length,
    diverged: ok.filter((r) => r.match === false).length,
    old_total: old.length,
    old_ok: old.filter((r) => r.status === 'ok').length,
    reasons,
    ms_median: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    ms_max: ms.length ? ms[ms.length - 1] : null,
    rows,
  }
}

it.skipIf(!out)('compare RPC endpoints on the public vectors', async () => {
  const only = (process.env.KYW_COMPARE_ONLY ?? '').split(',').filter(Boolean)
  const usable = endpoints.filter((e) => e.url && (only.length === 0 || only.includes(e.label)))
  const results = await Promise.all(usable.map(measure))
  const report = {
    measured_at: new Date().toISOString(),
    client: 'kyw-core (TypeScript), Node ' + process.version,
    fact_type: 'tx.core',
    spec_version: '0',
    manifest_sha256: sha256Hex(manifestBytes),
    read_params: READ_PARAMS,
    vectors: targets.length,
    skipped_no_key: endpoints.filter((e) => !e.url).map((e) => e.label),
    endpoints: results,
  }
  writeFileSync(out, JSON.stringify(report, null, 1))
  for (const r of results) {
    console.log(
      `${r.label.padEnd(18)} ${r.access.padEnd(6)} ok ${String(r.ok).padStart(2)}/${r.total} matched ${String(r.matched).padStart(2)} diverged ${r.diverged} old ${r.old_ok}/${r.old_total} median ${r.ms_median} ms ${JSON.stringify(r.reasons)}`,
    )
  }
  expect(results.length).toBeGreaterThan(0)
}, 600_000)
