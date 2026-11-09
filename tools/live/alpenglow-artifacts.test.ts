// Explicit local integration check; never opens a provider connection.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CertificateClient } from '../../src/alpenglow/client'
import { MAINNET_POLICY } from '../../src/alpenglow/verifier'

it('verifies retained live and historical artifacts through the phone client', async () => {
  const root = resolve(process.env.ALPENGLOW_ARCHIVE ?? 'dist/alpenglow-archive')
  const client = new CertificateClient(async (path, { maxBytes }) => {
    const data = readFileSync(resolve(root, path))
    expect(data.length).toBeLessThanOrEqual(maxBytes)
    return new Uint8Array(data)
  }, MAINNET_POLICY)
  const files = readdirSync(resolve(root, 'certificates')).filter((f) => /^\d+\.json$/.test(f))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const slot = Number(file.replace('.json', ''))
    const result = await client.check(slot)
    expect(result, `slot ${slot}`).toMatchObject({ status: 'untrusted-table', signatureValid: true })
  }
  console.log(`ALPENGLOW_ARCHIVE_VERIFIED ${files.length}`)
}, 30000)
