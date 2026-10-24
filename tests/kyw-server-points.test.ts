import { describe, expect, it } from 'vitest'
import { fetchServerPoints, formatServerPoints, mergeDays, parseDays, parseResetsAt, parseServerPoints, tzOffsetMin } from '../src/kyw/server-points'
import { showNoGenesis, withServerClass } from '../src/kyw/points'

const body = { points: 12, matched: 15, since: '2026-10-10T12:00:00Z', today: { counted: 12, cap: 200 }, user_class: 'unattested' }

const fakeFetch = (status: number, json: unknown, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url)
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status })
  }) as unknown as typeof fetch

describe('parseServerPoints', () => {
  it('reads its fields and ignores the rest; no link and no SKR block read as null', () => {
    expect(parseServerPoints(body)).toEqual({ points: 12, matched: 15, since: '2026-10-10T12:00:00Z', today: { counted: 12, cap: 200, resetsAt: null }, wallet: null, skr: null, userClass: 'unattested', days: null })
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
    const r = await fetchServerPoints({ fetch: fakeFetch(200, body, seen), apiBase: 'https://api.test', tzOffsetMin: -180 }, 'k1:a+b/c')
    expect(r?.points).toBe(12)
    expect(seen[0]).toBe('https://api.test/v1/kyw/points?device_key_id=k1%3Aa%2Bb%2Fc&tz_offset_min=-180')
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

describe('server class', () => {
  const base = { points: 0, matched: 0, since: null, today: { counted: 0, cap: 200 } }
  it('reads a known user_class and drops anything else', () => {
    expect(parseServerPoints({ ...base, user_class: 'attested_genesis' })?.userClass).toBe('attested_genesis')
    expect(parseServerPoints({ ...base, user_class: 'gold' })?.userClass).toBeNull()
    expect(parseServerPoints(base)?.userClass).toBeNull()
  })
  it('the class SolSentry holds wins over the phone cached check; own RPC stays local', () => {
    const cached = { deviceVerified: true, genesis: true, independentRpc: true }
    expect(withServerClass(cached, 'unattested')).toEqual({ deviceVerified: false, genesis: false, independentRpc: true })
    expect(withServerClass(cached, 'attested')).toEqual({ deviceVerified: true, genesis: false, independentRpc: true })
    expect(withServerClass({ ...cached, genesis: false }, 'attested_genesis')).toMatchObject({ genesis: true })
    expect(withServerClass(cached, null)).toBe(cached)
  })
})

describe('phone and wallet totals', () => {
  const base = { points: 84, matched: 42, since: null, today: { counted: 42, cap: 200 } }
  it('keeps the wallet total apart from the phone total', () => {
    const got = parseServerPoints({ ...base, wallet: { address: 'EfCs…fmZa', points: 0, link_id: 3 } })
    expect(got?.points).toBe(84)
    expect(got?.wallet).toEqual({ address: 'EfCs…fmZa', linkId: 3, points: 0 })
    expect(parseServerPoints({ ...base, wallet: { address: 'x', link_id: 3 } })?.wallet?.points).toBeNull()
  })
})

describe('no-Genesis notice', () => {
  const w = (genesis: boolean, status: string) => ({ address: 'EfCs1', genesis, sgt: { status } })
  it('shows for a wallet known to hold no Genesis Token until closed for that wallet', () => {
    expect(showNoGenesis(w(false, 'none'), null)).toBe(true)
    expect(showNoGenesis(w(false, 'none'), 'EfCs1')).toBe(false)
    expect(showNoGenesis(w(false, 'none'), 'other')).toBe(true)
    expect(showNoGenesis(w(true, 'verified'), null)).toBe(false)
    expect(showNoGenesis(w(false, 'unknown'), null)).toBe(false)
    expect(showNoGenesis(null, null)).toBe(false)
  })
})

describe('the cap window reset time', () => {
  it('reads an ISO time or epoch seconds, and nothing else', () => {
    expect(parseResetsAt('2026-10-13T00:00:00Z')).toBe(Date.parse('2026-10-13T00:00:00Z'))
    expect(parseResetsAt(1_760_313_600)).toBe(1_760_313_600_000)
    expect(parseResetsAt('tomorrow')).toBeNull()
    expect(parseResetsAt(5)).toBeNull()
    expect(parseResetsAt(null)).toBeNull()
  })
  it('comes through parseServerPoints', () => {
    expect(parseServerPoints({ ...body, today: { counted: 1, cap: 200, resets_at: '2026-10-13T00:00:00Z' } })?.today.resetsAt).toBe(Date.parse('2026-10-13T00:00:00Z'))
  })
})

describe('wallet days for the 28-day grid', () => {
  it('parses the server days and drops the field on any bad entry', () => {
    expect(parseDays({ '2026-10-23': 32, '2026-10-24': 86 })).toEqual({ '2026-10-23': 32, '2026-10-24': 86 })
    expect(parseDays({})).toEqual({})
    for (const bad of [null, [], 'x', { '2026-10-23': -1 }, { '2026-10-23': 1.5 }, { '23/10/2026': 3 }, { '2026-10-23': '3' }]) expect(parseDays(bad)).toBeNull()
    expect(parseServerPoints({ ...body, days: { '2026-10-24': 2 } })?.days).toEqual({ '2026-10-24': 2 })
    expect(parseServerPoints(body)?.days).toBeNull()
  })
  it('takes the higher count per day and keeps the phone history without wallet days', () => {
    const local = { '2026-10-23': 5, '2026-10-24': 9 }
    expect(mergeDays(local, null)).toBe(local)
    expect(mergeDays(local, { '2026-10-01': 40, '2026-10-24': 3 })).toEqual({ '2026-10-01': 40, '2026-10-23': 5, '2026-10-24': 9 })
  })
  it('sends a whole-minute offset inside the server range', () => {
    const m = tzOffsetMin(Date.UTC(2026, 9, 24))
    expect(Number.isInteger(m) && m >= -840 && m <= 840).toBe(true)
  })
})
