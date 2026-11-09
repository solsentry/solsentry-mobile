// Wire primitives shared by the phone verifier and its transport adapter.
export class CertificateError extends Error {}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CertificateError(message)
}

export function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max, name)
  return value
}

export function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  return value as Record<string, unknown>
}

export function base64(value: unknown, maxBytes: number): Uint8Array {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(maxBytes / 3) * 4, 'Base64 size')
  requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Base64 encoding')
  const raw = globalThis.atob(value)
  // Reject alternative encodings of the same bytes (including nonzero padding bits).
  requireValue(globalThis.btoa(raw) === value && raw.length <= maxBytes, 'Noncanonical base64')
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export function signedPayload(tag: number, slot: number, blockId: Uint8Array, shredVersion: number): Uint8Array {
  const out = new Uint8Array(11 + blockId.length)
  const view = new DataView(out.buffer)
  out[0] = tag
  view.setBigUint64(1, BigInt(slot), true)
  out.set(blockId, 9)
  view.setUint16(9 + blockId.length, shredVersion, true)
  return out
}

// solana-signer-store 0.1.0: Lsb0 Base2, or five little-endian trits per byte.
// Padding is ignored exactly as in the upstream decoder; it cannot add signers.
export function signerGroups(bitmap: Uint8Array, rows: number): { version: number; groups: number[][] } {
  requireValue(bitmap.length >= 3, 'Bitmap header')
  const version = bitmap[0],
    n = bitmap[1] | (bitmap[2] << 8)
  requireValue(version === 0 || version === 1, 'Unsupported bitmap version')
  requireValue(n > 0 && n <= rows, 'Bitmap rank beyond table')
  requireValue(bitmap.length === 3 + Math.ceil(n / (version === 0 ? 8 : 5)), 'Bitmap length')
  const groups: number[][] = version === 0 ? [[]] : [[], []]
  for (let i = 0; i < n; i++) {
    const digit =
      version === 0
        ? (bitmap[3 + (i >> 3)] >> (i % 8)) & 1
        : Math.floor(bitmap[3 + Math.floor(i / 5)] / 3 ** (i % 5)) % 3
    if (digit) groups[digit - 1].push(i)
  }
  requireValue(
    groups.some((g) => g.length > 0),
    'Empty signer set',
  )
  return { version, groups }
}
