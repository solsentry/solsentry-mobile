// Pack tests/fixtures/kyw_tx_core into one JSON file the self-test build can bundle. Each raw body
// is kept as a string, byte for byte, because the device must parse it with the lossless parser.
// Usage: node tools/gen_selftest_vectors.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'tests/fixtures/kyw_tx_core')
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
const vectors = manifest.vectors.map((v) => ({
  name: v.name,
  raw: readFileSync(join(dir, v.file), 'utf8'),
  raw_sha256: v.raw_sha256,
  status: v.status,
  unknown_reason: v.unknown_reason,
  fact_digest: v.fact_digest,
  failed: v.failed,
}))
writeFileSync(join(root, 'src/kyw/selftest/vectors.json'), JSON.stringify(vectors))
console.log(`${vectors.length} vectors written`)
