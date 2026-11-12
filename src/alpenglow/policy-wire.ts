// Exact-byte signed-policy primitives. No Node APIs, network, storage or secret keys.
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { concat, requireValue } from './codec'

export const POLICY_BYTES = 32768
export type JsonRecord = Record<string, unknown>

export function object(value: unknown): JsonRecord {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Object required')
  return value as JsonRecord
}
export function fields(value: unknown, names: readonly string[]): JsonRecord {
  const record = object(value)
  requireValue(
    Object.keys(record).length === names.length && names.every((name) => Object.hasOwn(record, name)),
    'Fields',
  )
  return record
}
export function list(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, 'Array limit')
  return value
}
export function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function scalarString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

/** Fatal UTF-8 decoding, independent of native TextDecoder availability. */
function utf8(raw: Uint8Array): string {
  const text: string[] = []
  for (let i = 0; i < raw.length;) {
    const first = raw[i++]
    if (first < 128) {
      text.push(String.fromCharCode(first))
      continue
    }
    const count =
      first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : -1
    requireValue(count > 0 && i + count <= raw.length, 'UTF-8')
    let cp = first & (count === 1 ? 31 : count === 2 ? 15 : 7)
    for (let j = 0; j < count; j++) {
      const next = raw[i++]
      requireValue((next & 0xc0) === 0x80, 'UTF-8 continuation')
      cp = (cp << 6) | (next & 63)
    }
    requireValue(
      cp >= (count === 1 ? 128 : count === 2 ? 2048 : 65536) && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff),
      'UTF-8 scalar',
    )
    text.push(String.fromCodePoint(cp))
  }
  return text.join('')
}

/** JSON.parse alone loses duplicate keys and the difference between 1 and 1.0. */
export function strictJson(raw: Uint8Array, maxBytes = POLICY_BYTES): unknown {
  requireValue(raw.length <= maxBytes, 'JSON size')
  const text = utf8(raw)
  let pos = 0
  const whitespace = () => {
    while (/[ \n\r\t]/.test(text[pos] ?? '') && pos < text.length) pos++
  }
  const string = (): string => {
    requireValue(text[pos] === '"', 'JSON string')
    const start = pos++
    while (pos < text.length) {
      const c = text[pos++]
      if (c === '\\') {
        pos++
        continue
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, pos))
        requireValue(scalarString(value), 'Unicode scalar')
        return value
      }
    }
    throw new Error('Unterminated string')
  }
  const value = (depth: number): unknown => {
    requireValue(depth <= 256, 'JSON depth')
    whitespace()
    const c = text[pos]
    if (c === '"') return string()
    if (c === '{') {
      pos++
      whitespace()
      const record = Object.create(null) as JsonRecord
      if (text[pos] === '}') {
        pos++
        return record
      }
      while (true) {
        whitespace()
        const key = string()
        requireValue(!/[^A-Za-z0-9_.:-]/.test(key) && !Object.hasOwn(record, key), 'JSON key')
        whitespace()
        requireValue(text[pos++] === ':', 'JSON colon')
        record[key] = value(depth + 1)
        whitespace()
        const end = text[pos++]
        if (end === '}') return record
        requireValue(end === ',', 'JSON object separator')
      }
    }
    if (c === '[') {
      pos++
      whitespace()
      const array: unknown[] = []
      if (text[pos] === ']') {
        pos++
        return array
      }
      while (true) {
        array.push(value(depth + 1))
        whitespace()
        const end = text[pos++]
        if (end === ']') return array
        requireValue(end === ',', 'JSON array separator')
      }
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, pos)) {
        pos += literal.length
        return decoded
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(pos))?.[0]
    requireValue(token !== undefined, 'JSON value')
    pos += token.length
    requireValue(!/[.eE]/.test(text[pos] ?? ''), 'JSON float')
    const number = Number(token)
    requireValue(Number.isSafeInteger(number), 'JSON integer')
    return number
  }
  const decoded = value(0)
  whitespace()
  requireValue(pos === text.length, 'Trailing JSON')
  return decoded
}

/** ADR canonical v1: integer-only JCS, ASCII object keys, scalar Unicode strings. */
export function canonical(value: unknown, depth = 0): Uint8Array {
  const encode = (v: unknown, d: number): string => {
    requireValue(d <= 256, 'Canonical depth')
    if (v === null || typeof v === 'boolean') return JSON.stringify(v)
    if (typeof v === 'number') {
      requireValue(Number.isSafeInteger(v), 'Canonical integer')
      return String(v)
    }
    if (typeof v === 'string') {
      requireValue(scalarString(v), 'Canonical string')
      return JSON.stringify(v)
    }
    if (Array.isArray(v)) return '[' + v.map((x) => encode(x, d + 1)).join(',') + ']'
    const record = object(v),
      keys = Object.keys(record).sort()
    requireValue(
      keys.every((key) => !/[^A-Za-z0-9_.:-]/.test(key)),
      'Canonical key',
    )
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + encode(record[key], d + 1)).join(',') + '}'
  }
  return utf8ToBytes(encode(value, depth))
}
export function digest(raw: Uint8Array): string {
  return bytesToHex(sha256(raw))
}
export function taggedDigest(tag: string, value: unknown): Uint8Array {
  return sha256(concat(utf8ToBytes(tag), new Uint8Array([0]), canonical(value)))
}
export function base64url(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array {
  requireValue(
    typeof value === 'string' && !/[^A-Za-z0-9_-]/.test(value) && value.length <= Math.ceil(maxBytes / 3) * 4,
    'Base64url',
  )
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = globalThis.atob(padded)
  requireValue(
    globalThis.btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value &&
      raw.length <= maxBytes &&
      (exactBytes === undefined || raw.length === exactBytes),
    'Canonical base64url',
  )
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
export function signatureValid(key: Uint8Array, signature: Uint8Array, bytes: Uint8Array): boolean {
  try {
    if (key.length !== 32 || signature.length !== 64) return false
    const publicPoint = ed25519.Point.fromBytes(key),
      r = ed25519.Point.fromBytes(signature.subarray(0, 32))
    // Generated Ed25519 keys/signatures are prime-subgroup points. Reject low-order
    // and mixed-torsion points instead of relying on ZIP-215's cofactored equation.
    if (publicPoint.isSmallOrder() || r.isSmallOrder() || !publicPoint.isTorsionFree() || !r.isTorsionFree())
      return false
    return ed25519.verify(signature, bytes, key, { zip215: false })
  } catch {
    return false
  }
}

export interface Delegation {
  keyId: string
  publicKey: Uint8Array
  notBefore: string
  notAfter: string
  use: string
}
export interface KeyRevocation {
  keyId: string
  from: string
}
// Unlike Python fullmatch, JavaScript $ permits a final newline. Use absolute EOF.
export const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z(?![\s\S])/
export function keyDirectory(
  input: unknown,
  root: Uint8Array,
  verify = signatureValid,
): { delegations: Delegation[]; revocations: KeyRevocation[] } {
  // Snapshot typed caller input through the strict JSON profile; nothing is retained.
  const data = fields(strictJson(input instanceof Uint8Array ? Uint8Array.from(input) : canonical(input), 262144), [
    'v',
    'delegations',
    'revocations',
  ])
  requireValue(root.length === 32 && data.v === 'key_directory/1', 'Directory')
  requireValue(list(data.delegations, 128).length + list(data.revocations, 128).length <= 128, 'Directory entry count')
  const delegations = list(data.delegations, 128).map((entry): Delegation => {
    const item = fields(entry, ['delegation', 'sig'])
    const d = fields(item.delegation, ['v', 'key_id', 'public_key', 'not_before', 'not_after', 'use'])
    const pub = base64url(d.public_key, 32, 32)
    requireValue(
      d.v === 'key/1' &&
        typeof d.key_id === 'string' &&
        /^[a-f0-9]{16}(?![\s\S])/.test(d.key_id) &&
        d.key_id === digest(pub).slice(0, 16),
      'Delegation key',
    )
    requireValue(
      typeof d.not_before === 'string' &&
        typeof d.not_after === 'string' &&
        TIME.test(d.not_before) &&
        TIME.test(d.not_after) &&
        d.not_before < d.not_after &&
        typeof d.use === 'string',
      'Delegation window',
    )
    requireValue(verify(root, base64url(item.sig, 64, 64), taggedDigest('solsentry/key/v1', d)), 'Root signature')
    return { keyId: d.key_id, publicKey: pub, notBefore: d.not_before, notAfter: d.not_after, use: d.use }
  })
  const revocations = list(data.revocations, 128).map((entry): KeyRevocation => {
    const item = fields(entry, ['revocation', 'sig'])
    const r = fields(item.revocation, ['v', 'key_id', 'from', 'reason'])
    requireValue(
      r.v === 'key_revocation/1' &&
        typeof r.key_id === 'string' &&
        /^[a-f0-9]{16}(?![\s\S])/.test(r.key_id) &&
        typeof r.from === 'string' &&
        TIME.test(r.from) &&
        typeof r.reason === 'string',
      'Revocation',
    )
    requireValue(
      verify(root, base64url(item.sig, 64, 64), taggedDigest('solsentry/key_revocation/v1', r)),
      'Root revocation signature',
    )
    return { keyId: r.key_id, from: r.from }
  })
  return { delegations, revocations }
}
