import { describe, expect, it } from 'vitest'

import type { ServerPoints } from '../src/kyw/server-points'
import { shouldOfferWidget, widgetAsk } from '../src/kyw/widget-offer'

const server = (counted: number, cap: number | null): ServerPoints => ({
  points: 0,
  matched: 0,
  since: null,
  today: { counted, cap, resetsAt: null },
  wallet: null,
  skr: null,
  userClass: null,
})
const info = { pinSupported: true, count: 0 }

describe('widget offer', () => {
  it('shows after the first claim sent or once today is capped', () => {
    expect(shouldOfferWidget({ info, offered: false, claimSent: true, server: null })).toBe(true)
    expect(shouldOfferWidget({ info, offered: false, claimSent: false, server: server(200, 200) })).toBe(true)
  })

  it('stays away before either, once offered, with a widget placed, or when the launcher cannot pin', () => {
    expect(shouldOfferWidget({ info, offered: false, claimSent: false, server: server(199, 200) })).toBe(false)
    expect(shouldOfferWidget({ info, offered: false, claimSent: false, server: server(500, null) })).toBe(false)
    expect(shouldOfferWidget({ info, offered: true, claimSent: true, server: null })).toBe(false)
    expect(shouldOfferWidget({ info: { pinSupported: true, count: 1 }, offered: false, claimSent: true, server: null })).toBe(false)
    expect(shouldOfferWidget({ info: { pinSupported: false, count: 0 }, offered: false, claimSent: true, server: null })).toBe(false)
    expect(shouldOfferWidget({ info: null, offered: false, claimSent: true, server: null })).toBe(false)
  })
})

describe('widget button link', () => {
  it('reads start or stop with the tap id', () => {
    expect(widgetAsk({ widget: 'start', t: '1792787524915' })).toEqual({ action: 'start', id: '1792787524915' })
    expect(widgetAsk({ widget: ['stop'], t: ['42'] })).toEqual({ action: 'stop', id: '42' })
  })

  it('ignores anything else', () => {
    expect(widgetAsk({})).toBeNull()
    expect(widgetAsk({ widget: 'start' })).toBeNull()
    expect(widgetAsk({ widget: 'claim', t: '1' })).toBeNull()
    expect(widgetAsk({ widget: 'stop', t: 'x1' })).toBeNull()
  })
})
