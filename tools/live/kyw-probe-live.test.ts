// Not part of `npm test`. Runs the capability probe from Node against real RPC endpoints, with
// public targets, and writes the reports. Only a label and a host are written, never a URL.
//   KYW_PROBE_OUT=/path/out.json KYW_COMPARE_ENV=/path/.env npx vitest run --config tools/live/vitest.config.ts kyw-probe-live
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { fetchWithTimeout } from '../../src/guard/fetch-timeout'
import { runProbe, type ProbeTargets } from '../../src/kyw/probe'

const out = process.env.KYW_PROBE_OUT ?? ''
const DIR = join(__dirname, '../../tests/fixtures/kyw_tx_core')
const old = (JSON.parse(readFileSync(join(DIR, 'raw/tx_20.json'), 'utf8')) as {
  result: { blockTime: number; transaction: { signatures: string[]; message: { instructions: { programId: string }[] } } }
}).result

function envFile(): Record<string, string> {
  const path = process.env.KYW_COMPARE_ENV
  const vars: Record<string, string> = {}
  if (!path) return vars
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return vars
}
const env = envFile()
const solami = env.SOLAMI_API_KEY ?? process.env.KYW_COMPARE_SOLAMI_KEY

const endpoints: { label: string; access: string; url: string | undefined; host: string }[] = [
  { label: 'solana-public', access: 'no key', url: 'https://api.mainnet-beta.solana.com', host: 'api.mainnet-beta.solana.com' },
  { label: 'publicnode', access: 'no key', url: 'https://solana-rpc.publicnode.com', host: 'solana-rpc.publicnode.com' },
  { label: 'tatum-public', access: 'no key', url: 'https://solana-mainnet.gateway.tatum.io', host: 'solana-mainnet.gateway.tatum.io' },
  { label: 'helius', access: 'key', url: env.HELIUS_API_KEY_2 && `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY_2}`, host: 'mainnet.helius-rpc.com' },
  { label: 'solami', access: 'key', url: solami && `https://rpc.solami.dev/solana?api-key=${solami}`, host: 'rpc.solami.dev' },
  { label: 'quicknode', access: 'key', url: env.QUICKNODE_DAS_URL, host: 'solana-mainnet.quiknode.pro' },
  { label: 'alchemy', access: 'key', url: env.ALCHEMY_RPC_URL_1, host: 'g.alchemy.com' },
  { label: 'chainstack', access: 'key', url: env.CHAINSTACK_RPC_URL, host: 'core.chainstack.com' },
  { label: 'rpcfast', access: 'key', url: env.RPCFAST_RPC_URL_1, host: 'rpcfast.com' },
]

it.skipIf(!out)('probe RPC endpoints', async () => {
  const timed = fetchWithTimeout(fetch, 10_000, 'Request')
  // A fresh, finalized signature of a public program (Jupiter v6), read from the public endpoint.
  const fresh = (await (
    await timed('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', { limit: 1, commitment: 'finalized' }],
      }),
    })
  ).json()) as { result: { signature: string; blockTime: number }[] }
  const targets: ProbeTargets = {
    probe_version: '0',
    recent_signature: fresh.result[0].signature,
    archival_signature: old.transaction.signatures[0],
    page_address: old.transaction.message.instructions[0].programId,
    page_before_signature: old.transaction.signatures[0],
    account: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    read: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
  }
  const reports = []
  for (const e of endpoints.filter((x) => x.url)) {
    const report = await runProbe({
      fetch: timed,
      url: e.url!,
      host: e.host,
      targets,
      clientVersion: '0.1.0-node',
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    reports.push({ label: e.label, access: e.access, ...report })
    const c = report.capabilities
    const show = (x: { class: string; page_size?: number; reason?: string; ms?: number }) =>
      `${x.class}${x.page_size ? `(${x.page_size})` : ''}${x.reason ? `[${x.reason}]` : ''}${x.ms !== undefined ? ` ${x.ms}ms` : ''}`
    console.log(`${e.label.padEnd(14)} C1 ${show(c.C1)} | C2 ${show(c.C2)} | C3 ${show(c.C3)} | C4 ${show(c.C4)} | C5 ${show(c.C5)} | C6 ${c.C6.min_interval_ms}`)
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        measured_from: 'PC (Node), not the phone',
        targets: {
          recent: `Jupiter v6 transaction, block time ${new Date(fresh.result[0].blockTime * 1000).toISOString()}`,
          archival: `vector tx_20, block time ${new Date(old.blockTime * 1000).toISOString()}`,
          page_address: targets.page_address,
          account: targets.account,
        },
        skipped_no_key: endpoints.filter((x) => !x.url).map((x) => x.label),
        reports,
      },
      null,
      1,
    ),
  )
  expect(reports.length).toBeGreaterThan(0)
}, 600_000)
