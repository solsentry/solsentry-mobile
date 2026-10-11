import { describe, expect, it } from 'vitest'
import { fetchServerPoints, formatServerPoints, parseServerPoints } from '../src/kyw/server-points'

const body = { points: 12, matched: 15, since: '2026-10-10T12:00:00Z', today: { counted: 12, cap: 200 }, user_class: 'unattested' }

const fakeFetch = (status: number, json: unknown, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url)
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status })
  }) as unknown as typeof fetch

describe('parseServerPoints', () => {
  it('reads its fields and ignores the rest; no link and no SKR block read as null', () => {
    expect(parseServerPoints(body)).toEqual({ points: 12, matched: 15, since: '2026-10-10T12:00:00Z', today: { counted: 12, cap: 200 }, wallet: null, skr: null })
  })
  it('accepts a device with no result yet and a device with no cap', () => {
    expect(parseServerPoints({ ...body, points: 0, matched: 0, since: null, today: { counted: 0, cap: null } })?.today.cap).toBeNull()
  })
  it('rejects a body that is not a balance', () => {
    for (const bad of [null, 'x', {}, { ...body, points: -1 }, { ...body, points: '12' }, { ...body, since: 5 }, { ...body, today: null }, { ...body, today: { counted: 1 } }])
      expect(parseServerPoints(bad)).toBeNull()
  })
})

describe('fetchServerPoints', () => {
  it('asks for this device and returns the balance', async () => {
    const seen: string[] = []
    const r = await fetchServerPoints({ fetch: fakeFetch(200, body, seen), apiBase: 'https://api.test' }, 'k1:a+b/c')
    expect(r?.points).toBe(12)
    expect(seen[0]).toBe('https://api.test/v1/kyw/points?device_key_id=k1%3Aa%2Bb%2Fc')
  })
  it('is null while the route is not deployed, on a bad body and on a network error', async () => {
    expect(await fetchServerPoints({ fetch: fakeFetch(404, '404: Not Found'), apiBase: 'x' }, 'k1:a')).toBeNull()
    expect(await fetchServerPoints({ fetch: fakeFetch(200, 'not json'), apiBase: 'x' }, 'k1:a')).toBeNull()
    const broken = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchServerPoints({ fetch: broken, apiBase: 'x' }, 'k1:a')).toBeNull()
  })
})

describe('formatServerPoints', () => {
  it('shows whole points and at most two decimals', () => {
    expect(formatServerPoints(1200)).toBe('1,200')
    expect(formatServerPoints(3.3)).toBe('3.3')
    expect(formatServerPoints(1.105)).toBe('1.11')
  })
})
