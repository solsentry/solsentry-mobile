// Explicit local integration check; never opens a provider connection.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CertificateClient } from '../../src/alpenglow/client'
import { EpochTable, MAINNET_POLICY } from '../../src/alpenglow/verifier'

it('verifies retained live and historical artifacts through the phone client', async () => {
  const root = resolve(process.env.ALPENGLOW_ARCHIVE ?? 'dist/alpenglow-archive')
  let selected: Uint8Array
  const client = new CertificateClient(async (path, { maxBytes }) => {
    const data = path.startsWith('certificates/') ? selected : readFileSync(resolve(root, path))
    expect(data.length).toBeLessThanOrEqual(maxBytes)
    return new Uint8Array(data)
  }, MAINNET_POLICY)
  const variants = resolve(root, 'certificate-variants')
  const files = existsSync(variants)
    ? readdirSync(variants, { recursive: true })
        .filter((f) => /^\d+\/[a-f0-9]{64}\.json$/.test(String(f)))
        .map((f) => resolve(variants, String(f)))
    : readdirSync(resolve(root, 'certificates'))
        .filter((f) => /^\d+\.json$/.test(f))
        .map((f) => resolve(root, 'certificates', f))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    selected = new Uint8Array(readFileSync(file))
    const slot = JSON.parse(Buffer.from(selected).toString('utf8')).slot
    const result = await client.check(slot)
    expect(result, `slot ${slot}`).toMatchObject({ status: 'untrusted-table', signatureValid: true })
  }
  console.log(`ALPENGLOW_ARCHIVE_VERIFIED ${files.length}`)
}, 120000)

it('prepares the next archived epoch table without claiming a certificate for that epoch', async () => {
  const root = resolve(process.env.ALPENGLOW_ARCHIVE ?? 'dist/alpenglow-archive')
  const slots = readdirSync(resolve(root, 'certificates'))
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => Number(file.replace('.json', '')))
  expect(slots.length).toBeGreaterThan(0)
  const nextEpoch = Math.floor(Math.max(...slots) / MAINNET_POLICY.slotsPerEpoch) + 1
  const raw = new Uint8Array(readFileSync(resolve(root, `epochs/${nextEpoch}/table.bin`)))
  const table = await EpochTable.loadAsync(raw, MAINNET_POLICY)
  expect(table.info).toMatchObject({ epoch: nextEpoch, trust: 'untrusted' })
  console.log(`ALPENGLOW_NEXT_TABLE_PREPARED ${nextEpoch} ${table.info.sha256}`)
}, 30000)
