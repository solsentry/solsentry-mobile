// Balance that SolSentry computes from the signed results of this device (GET /v1/kyw/points).
// Until the route answers, the app shows its own estimate; a failed read is "not known", never zero.

export interface ServerPoints {
  points: number
  matched: number
  /** ISO time of the first counted result, or null before any. */
  since: string | null
  /** `cap` is null for a device the server does not cap. */
  today: { counted: number; cap: number | null }
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** The four fields the app reads; anything else in the body is ignored. Null when the body is not a balance. */
export function parseServerPoints(body: unknown): ServerPoints | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const today = b.today as Record<string, unknown> | null | undefined
  if (!count(b.points) || !count(b.matched)) return null
  if (b.since !== null && typeof b.since !== 'string') return null
  if (typeof today !== 'object' || today === null || !count(today.counted)) return null
  if (today.cap !== null && !count(today.cap)) return null
  return {
    points: b.points,
    matched: b.matched,
    since: b.since,
    today: { counted: today.counted, cap: today.cap },
  }
}

/** Null on any failure (route not deployed, network, bad body): the caller keeps the local estimate. */
export async function fetchServerPoints(
  deps: { fetch: typeof fetch; apiBase: string },
  deviceKeyId: string,
): Promise<ServerPoints | null> {
  try {
    const res = await deps.fetch(`${deps.apiBase}/v1/kyw/points?device_key_id=${encodeURIComponent(deviceKeyId)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return parseServerPoints(await res.json())
  } catch {
    return null
  }
}

/** Up to two decimals: whole while no multiplier applies, 1.1× results leave a fraction. */
export function formatServerPoints(points: number): string {
  return points.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
