// Runs the shared vectors with the same code the app uses. On the phone this is the proof that
// Hermes computes what Node and the Python reference compute.
import { readOutcome, sha256Hex, utf8 } from '../../kyw-core'

export interface SelfTestVector {
  name: string
  raw: string
  raw_sha256: string
  status: string
  unknown_reason: string | null
  fact_digest: string | null
  failed: boolean | null
}

export interface SelfTestReport {
  total: number
  passed: number
  failures: string[]
  ms: number
}

export function runSelfTest(vectors: SelfTestVector[], now: () => number = Date.now): SelfTestReport {
  const started = now()
  const failures: string[] = []
  for (const v of vectors) {
    try {
      const out = readOutcome(v.raw)
      const ok =
        sha256Hex(utf8(v.raw)) === v.raw_sha256 &&
        out.status === v.status &&
        out.unknownReason === v.unknown_reason &&
        out.factDigest === v.fact_digest &&
        out.failed === v.failed
      if (!ok) failures.push(v.name)
    } catch {
      failures.push(v.name)
    }
  }
  return { total: vectors.length, passed: vectors.length - failures.length, failures, ms: now() - started }
}
