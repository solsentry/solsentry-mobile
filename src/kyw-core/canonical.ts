// Canonical form of a fact: keys sorted by code point, no whitespace, integers as bare integers at
// any size, UTF-8. Byte-for-byte equal to the Python reference
// (json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)).
import { sha256 } from '@noble/hashes/sha2.js'

import { Num, type Value } from './lossless'

/** Raised for anything the fact contract forbids or cannot read. Becomes unknown/invalid_response. */
export class FactError extends Error {}

/** Order two UTF-16 code units the way their code points order (surrogates above U+FFFF). */
function rank(unit: number): number {
  if (unit < 0xd800) return unit
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000
}

/** String order by Unicode code point, as Python compares str. JS `<` compares UTF-16 units. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) return rank(x) - rank(y)
  }
  return a.length - b.length
}

const HEX = '0123456789abcdef'

function quote(s: string): string {
  let out = '"'
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    let esc: string | null = null
    if (c === 0x22) esc = '\\"'
    else if (c === 0x5c) esc = '\\\\'
    else if (c === 0x0a) esc = '\\n'
    else if (c === 0x0d) esc = '\\r'
    else if (c === 0x09) esc = '\\t'
    else if (c === 0x08) esc = '\\b'
    else if (c === 0x0c) esc = '\\f'
    else if (c < 0x20) esc = '\\u00' + HEX[c >> 4] + HEX[c & 15]
    if (esc !== null) {
      out += s.slice(start, i) + esc
      start = i + 1
    }
  }
  return out + s.slice(start) + '"'
}

export function canonicalJson(value: Value): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'string') return quote(value)
  if (value instanceof Num) {
    if (!value.isInt) throw new FactError('floating point value in a fact')
    return BigInt(value.raw).toString()
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort(compareCodePoints)
  return '{' + keys.map((k) => quote(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

/** UTF-8 without TextEncoder, so Node and Hermes cannot disagree. A lone surrogate is an error. */
export function utf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3)
  let o = 0
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdfff) {
      const low = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (c > 0xdbff || low < 0xdc00 || low > 0xdfff) throw new FactError('lone surrogate in a fact')
      c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00)
      i++
    }
    if (c < 0x80) out[o++] = c
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6)
      out[o++] = 0x80 | (c & 0x3f)
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12)
      out[o++] = 0x80 | ((c >> 6) & 0x3f)
      out[o++] = 0x80 | (c & 0x3f)
    } else {
      out[o++] = 0xf0 | (c >> 18)
      out[o++] = 0x80 | ((c >> 12) & 0x3f)
      out[o++] = 0x80 | ((c >> 6) & 0x3f)
      out[o++] = 0x80 | (c & 0x3f)
    }
  }
  return out.subarray(0, o)
}

export function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  return out
}

export function sha256Hex(bytes: Uint8Array): string {
  return hex(sha256(bytes))
}

/** sha256 over the UTF-8 bytes of the canonical form, lowercase hex. */
export function factDigest(fact: Value): string {
  return sha256Hex(utf8(canonicalJson(fact)))
}
