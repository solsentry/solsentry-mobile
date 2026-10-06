import { describe, expect, it } from 'vitest'
import { screenRecipient, screenSender } from '../src/guard/service'

function g(analysis: unknown, operator: unknown = { wallet: 'a', known: false, risk_level: 'UNKNOWN' }) {
  return {
    analyzeProgram: async () => analysis,
    checkLookalike: async () => ({ is_lookalike: false }),
    getOperator: async () => operator,
  } as never
}

const bad: [string, unknown][] = [
  ['empty object', {}],
  ['array', []],
  ['unknown verdict', { verdict: 'weird', risk_score: 0 }],
  ['wrong-case verdict', { verdict: 'Dangerous', risk_score: 0 }],
  ['null risk_score', { verdict: 'safe', risk_score: null }],
  ['string risk_score', { verdict: 'safe', risk_score: 'n/a' }],
  ['NaN risk_score', { verdict: 'safe', risk_score: NaN }],
  ['flags not an array', { verdict: 'safe', risk_score: 0, flags: 'x' }],
]

const noRpc = { fetch: (async () => { throw new Error('no rpc') }) as never }

describe('malformed API bodies fail closed', () => {
  for (const [name, body] of bad) {
    it(`recipient: ${name} -> block`, async () => {
      const v = await screenRecipient('a', g(body))
      expect(v.decision).toBe('block')
    })
    it(`sender: ${name} -> block`, async () => {
      const v = await screenSender('a', g(body), noRpc)
      expect(v.decision).toBe('block')
    })
  }
  it('operator body not an object -> block', async () => {
    const v = await screenRecipient('a', g({ verdict: 'safe', risk_score: 0, flags: null }, null))
    expect(v.decision).toBe('block')
  })
  it('a well-formed safe body still allows', async () => {
    const v = await screenRecipient('a', g({ verdict: 'safe', risk_score: 0, flags: null, kind: 'wallet' }))
    expect(v.decision).toBe('allow')
  })
})
