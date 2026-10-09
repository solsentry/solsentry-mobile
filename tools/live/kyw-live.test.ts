// Not part of `npm test`. Runs real tasks from Node against a KYW server:
//   KYW_LIVE_API=http://127.0.0.1:8092 [KYW_LIVE_HELIUS_KEY=...] npx vitest run --config tools/live/vitest.config.ts
import { expect, it } from 'vitest'

import { fetchWithTimeout } from '../../src/guard/fetch-timeout'
import { resolveEndpoint, type ProviderId } from '../../src/kyw/providers'
import { runOneTask } from '../../src/kyw/run'

const api = process.env.KYW_LIVE_API ?? ''
const count = Number(process.env.KYW_LIVE_COUNT ?? 10)

async function run(provider: ProviderId, secret: string) {
  const endpoint = resolveEndpoint(provider, secret, new URL(api).hostname)
  if (!endpoint.ok) throw new Error(endpoint.problem)
  const rows = []
  for (let i = 0; i < count; i++) {
    const out = await runOneTask({
      fetch: fetchWithTimeout(fetch, 10_000, 'Request'),
      apiBase: api,
      provider,
      endpoint,
      clientVersion: '0.1.0-node',
      now: Date.now,
    })
    const r = out.record
    rows.push(r)
    console.log(`${provider} ${i + 1}/${count} ${r.short} ${r.verdict} ${r.reason ?? ''} ${r.ms} ms ${r.bytes} B ${r.host}`)
    await new Promise((resolve) => setTimeout(resolve, 2100))
  }
  return rows
}

it.skipIf(!api)('default RPC through the server', async () => {
  const rows = await run('solsentry', '')
  expect(rows.every((r) => r.verdict === 'accepted' || (r.verdict === 'unknown' && r.reason))).toBe(true)
}, 120_000)

it.skipIf(!api || !process.env.KYW_LIVE_HELIUS_KEY)('own Helius key', async () => {
  const rows = await run('helius', process.env.KYW_LIVE_HELIUS_KEY ?? '')
  expect(rows.every((r) => r.verdict === 'accepted' || (r.verdict === 'unknown' && r.reason))).toBe(true)
}, 120_000)
