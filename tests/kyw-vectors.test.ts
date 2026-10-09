import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FACT_TYPE, READ_PARAMS, SPEC_VERSION, readOutcome, sha256Hex } from '../src/kyw-core'

const DIR = join(__dirname, 'fixtures', 'kyw_tx_core')
/** sha256 of manifest.json as copied from the server branch (wt/kyw-v0, c46a039b). */
const MANIFEST_SHA256 = 'a2dd3887d1ae50da3f589e98347370ef652619f8e6978aeb1d53318861e4986f'

interface Vector {
  name: string
  file: string
  raw_sha256: string
  status: 'ok' | 'unknown'
  unknown_reason: string | null
  fact_digest: string | null
  failed: boolean | null
}

const manifestBytes = readFileSync(join(DIR, 'manifest.json'))
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  fact_type: string
  spec_version: string
  read_params: Record<string, unknown>
  vectors: Vector[]
}

describe('kyw tx.core vectors', () => {
  it('uses the manifest the server committed', () => {
    expect(sha256Hex(manifestBytes)).toBe(MANIFEST_SHA256)
    expect(manifest.fact_type).toBe(FACT_TYPE)
    expect(manifest.spec_version).toBe(SPEC_VERSION)
    expect(manifest.read_params).toEqual(READ_PARAMS)
    expect(manifest.vectors).toHaveLength(41)
  })

  it.each(manifest.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const bytes = readFileSync(join(DIR, v.file))
    expect(sha256Hex(bytes)).toBe(v.raw_sha256)
    const out = readOutcome(bytes.toString('utf8'))
    expect({
      status: out.status,
      unknown_reason: out.unknownReason,
      fact_digest: out.factDigest,
      failed: out.failed,
    }).toEqual({ status: v.status, unknown_reason: v.unknown_reason, fact_digest: v.fact_digest, failed: v.failed })
  })
})
