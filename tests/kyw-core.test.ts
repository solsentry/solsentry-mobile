import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  FactError,
  Num,
  ParseError,
  canonicalJson,
  compareCodePoints,
  parseLossless,
  readOutcome,
  utf8,
  type Value,
} from '../src/kyw-core'

const FIXTURES = join(__dirname, 'fixtures')

interface EdgeCase {
  name: string
  raw: string
  expected: { status?: string; unknown_reason?: string | null; fact_digest?: string | null; reference_raised?: string }
}
const edgeCases = JSON.parse(readFileSync(join(FIXTURES, 'kyw_edge_cases.json'), 'utf8')) as EdgeCase[]

/** Lossless tree -> what JSON.parse would give (numbers as JS numbers). */
function plain(v: Value): unknown {
  if (v instanceof Num) return Number(v.raw)
  if (Array.isArray(v)) return v.map(plain)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}

describe('kyw edge cases against the Python reference', () => {
  it.each(edgeCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const out = readOutcome(c.raw)
    if (c.expected.reference_raised) {
      // The reference raises an exception it does not catch on these bodies. The client must still
      // answer, and the only honest answer is unknown/invalid_response (or rpc_error for an error body).
      expect(out.status).toBe('unknown')
      return
    }
    expect({ status: out.status, unknown_reason: out.unknownReason, fact_digest: out.factDigest }).toEqual({
      status: c.expected.status,
      unknown_reason: c.expected.unknown_reason,
      fact_digest: c.expected.fact_digest,
    })
  })
})

describe('lossless parser', () => {
  it('agrees with JSON.parse on every public vector', () => {
    const dir = join(FIXTURES, 'kyw_tx_core', 'raw')
    const files = readdirSync(dir).filter((f) => f.startsWith('tx_'))
    expect(files.length).toBe(35)
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      expect(plain(parseLossless(text))).toEqual(JSON.parse(text))
    }
  })

  it('keeps integers above 2^53 and tells a float from an integer', () => {
    const v = parseLossless('[9007199254740993, 5000.0, 1e3, -0]') as Num[]
    expect(v[0].raw).toBe('9007199254740993')
    expect(canonicalJson(v[0])).toBe('9007199254740993')
    expect(v[1].isInt).toBe(false)
    expect(v[2].isInt).toBe(false)
    expect(canonicalJson(v[3])).toBe('0')
    expect(() => canonicalJson(v[1])).toThrow(FactError)
  })

  it.each([
    '', '{', '[1,]', '{"a":1,}', '01', '1.', '.5', '+1', 'NaN', 'Infinity', "{'a':1}", '"\n"', '"\\x"', '"\\u12"',
    'nul', '1 2', '{"a" 1}', '[1 2]', '"abc',
  ])('rejects %j', (text) => {
    expect(() => parseLossless(text)).toThrow(ParseError)
  })

  it('rejects absurd nesting instead of overflowing the stack', () => {
    expect(() => parseLossless('['.repeat(100000))).toThrow(ParseError)
  })

  it('does not let __proto__ or constructor keys change the object', () => {
    const v = parseLossless('{"__proto__":{"x":1},"constructor":2}')
    expect(canonicalJson(v)).toBe('{"__proto__":{"x":1},"constructor":2}')
  })
})

describe('canonical form', () => {
  it('sorts keys by code point, not by UTF-16 unit', () => {
    // U+FFFF sorts before U+1F600 by code point; by UTF-16 unit it would sort after.
    expect(compareCodePoints('￿', '\u{1F600}')).toBeLessThan(0)
    expect(canonicalJson(parseLossless('{"\u{1F600}":1,"￿":2,"a":3}'))).toBe('{"a":3,"￿":2,"\u{1F600}":1}')
  })

  it('encodes UTF-8 like TextEncoder and refuses a lone surrogate', () => {
    const s = 'aé€\u{1F600} ￿'
    expect(Array.from(utf8(s))).toEqual(Array.from(new TextEncoder().encode(s)))
    expect(() => utf8('\ud800')).toThrow(FactError)
    expect(() => utf8('\udc00a')).toThrow(FactError)
  })
})
