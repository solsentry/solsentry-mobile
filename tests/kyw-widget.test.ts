import { describe, expect, it } from 'vitest'

import { EMPTY } from '../src/kyw/history'
import type { ServerPoints } from '../src/kyw/server-points'
import { widgetContent, WIDGET_OFF, type WidgetInput } from '../src/kyw/widget'

const base: WidgetInput = {
  loaded: true,
  running: true,
  status: { kind: 'requesting' },
  history: { ...EMPTY, pointHalves: 7, counters: { accepted: 1234, diverged: 0, unknown: 0 } },
  server: null,
  deviceKind: 'random',
  now: Date.UTC(2026, 9, 12, 12),
}

const server: ServerPoints = {
  points: 81.5,
  matched: 2001,
  since: null,
  today: { counted: 30, cap: 50, resetsAt: null },
  wallet: null,
  skr: null,
  userClass: null,
}

describe('home screen widget content', () => {
  it('draws nothing before the store is loaded', () => {
    expect(widgetContent({ ...base, loaded: false })).toBeNull()
  })

  it('says off when the loop is not running, whatever the last status was', () => {
    const w = widgetContent({ ...base, running: false, status: { kind: 'reading', short: 'abc' } as WidgetInput['status'] })
    expect(w?.state).toBe('off')
    expect(w?.status).toBe(WIDGET_OFF)
  })

  it('maps the loop status to verifying, paused or the cap', () => {
    expect(widgetContent(base)).toMatchObject({ state: 'on', status: 'Verifying' })
    expect(widgetContent({ ...base, status: { kind: 'held', why: 'wifi' } as WidgetInput['status'] })).toMatchObject({
      state: 'paused',
      status: 'Paused · waiting for Wi-Fi',
    })
    expect(widgetContent({ ...base, status: { kind: 'waiting', why: 'capped', seconds: 300 } as WidgetInput['status'] })).toMatchObject({
      state: 'on',
      status: "Today's cap is reached",
    })
  })

  it('shows the local estimate for a random id', () => {
    expect(widgetContent(base)).toMatchObject({ figure: '3.5', unit: 'pts', today: '' })
  })

  it('keeps the last balance for a key device until SolSentry answers', () => {
    expect(widgetContent({ ...base, deviceKind: 'key' })).toMatchObject({ figure: null, unit: null, today: null })
    expect(widgetContent({ ...base, deviceKind: null })).toMatchObject({ figure: null, today: null })
  })

  it('leads with the linked wallet total, not this phone', () => {
    const linked = { ...server, wallet: { address: '8b67…', linkId: 16, points: 1778.7 } }
    expect(widgetContent({ ...base, deviceKind: 'key', server: linked })).toMatchObject({ figure: '1,778.7', unit: 'pts' })
    const unknown = { ...server, wallet: { address: '8b67…', linkId: 16, points: null } }
    expect(widgetContent({ ...base, deviceKind: 'key', server: unknown })).toMatchObject({ figure: '81.5' })
  })

  it('shows server points with today against the cap', () => {
    expect(widgetContent({ ...base, deviceKind: 'key', server })).toMatchObject({
      figure: '81.5',
      unit: 'pts',
      today: '30/50 results today',
    })
    expect(widgetContent({ ...base, server: { ...server, today: { counted: 3, cap: null, resetsAt: null } } })?.today).toBe('')
  })

  it('shows SKR when the server sends a balance', () => {
    const skr = { balanceRaw: 12_345_678n, window: { earnedRaw: 250_000n, capRaw: 1_000_000n }, minClaimRaw: 1_000_000n, pool: 'ok' as const, openClaim: null, openClaimRaw: null }
    expect(widgetContent({ ...base, deviceKind: 'key', server: { ...server, skr } })).toMatchObject({
      figure: '12.34',
      unit: 'SKR',
      today: '0.25/1 SKR today',
    })
  })

  it('shows points, not SKR, while the SKR window is closed (cap 0)', () => {
    const skr = { balanceRaw: 0n, window: { earnedRaw: 0n, capRaw: 0n }, minClaimRaw: 1_000_000n, pool: 'ok' as const, openClaim: null, openClaimRaw: null }
    expect(widgetContent({ ...base, deviceKind: 'key', server: { ...server, skr } })).toMatchObject({ figure: '81.5', unit: 'pts', today: '30/50 results today' })
  })
})
