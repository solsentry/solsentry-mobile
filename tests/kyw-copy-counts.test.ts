import { describe, expect, it } from 'vitest'
import { ACCOUNT_TEXT, INTRO_TEXT, switchProviderPrompt } from '../src/kyw/copy'

describe('points and caps on screen', () => {
  it('says 1 point, and points for any other figure', () => {
    expect(ACCOUNT_TEXT.pointsSplit('1', null)).toBe('1 point on this phone.')
    expect(ACCOUNT_TEXT.pointsSplit('8.4', '1')).toBe('8.4 points on this phone · 1 with this wallet.')
    expect(ACCOUNT_TEXT.pointsSplit('0', null)).toBe('0 points on this phone.')
  })
  it('names the daily cap in results, not points', () => {
    expect(ACCOUNT_TEXT.today(7, 200)).toBe('7/200 results today')
    expect(ACCOUNT_TEXT.today(250, 200)).toBe('200/200 results today')
  })
  it('does not claim a URL is already saved when switching to your RPC', () => {
    expect(switchProviderPrompt('Your RPC', true).body).not.toMatch(/saved/)
  })
})

describe('what points are worth', () => {
  it('says points have no cash value where the uses are listed and in how-it-works', () => {
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/no cash value/)
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/planned, not promised/)
    expect(INTRO_TEXT.steps[2].body).toMatch(/no cash value/)
  })
})
