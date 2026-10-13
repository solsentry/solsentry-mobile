import { describe, expect, it } from 'vitest'
import { ACCOUNT_TEXT, HOME_TEXT, INTRO_TEXT, UPDATE_TEXT, switchProviderPrompt } from '../src/kyw/copy'

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
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/SolSentry access, wallet tracking and wallet attestation/)
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/depend on partners/)
    expect(INTRO_TEXT.steps[2].body).toMatch(/no cash value/)
  })
})

describe('the daily cap on the Home', () => {
  it('says tasks still run and gives no reset hour (the window length is a server setting)', () => {
    expect(HOME_TEXT.capReached).toMatch(/Tasks still run/)
    expect(HOME_TEXT.capReached).not.toMatch(/\d/)
  })
})

describe('points and SKR are told apart', () => {
  it('never says points turn into SKR, and says a claim does not spend points', () => {
    for (const step of INTRO_TEXT.steps) expect(step.title).not.toMatch(/turn into SKR/)
    expect(INTRO_TEXT.steps[2].body).toMatch(/does not spend your points/)
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/does not spend points/)
  })
  it('says the caps and the Genesis-only rule belong to the test phase', () => {
    expect(ACCOUNT_TEXT.redeemLine).toMatch(/test phase/)
    expect(INTRO_TEXT.steps[2].body).toMatch(/test phase and will change/)
  })
  it('tells an updated phone that verification it left on comes back by itself', () => {
    expect(UPDATE_TEXT.how).toMatch(/If verification was on, it turns on again when you open the app/)
    expect(UPDATE_TEXT.how).not.toMatch(/turn it on again after installing/)
  })
})
