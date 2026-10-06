import { describe, expect, it } from 'vitest'
import { GuardError } from '../src/guard/client'
import { QUOTA_MESSAGE, screenRecipient, screenSender } from '../src/guard/service'

const quota = () => Promise.reject(new GuardError('SolSentry API 429', 429))
const guard = {
  analyzeProgram: quota,
  checkLookalike: async () => ({ is_lookalike: false }),
  getOperator: quota,
} as never

describe('HTTP 429 from the API', () => {
  it('recipient: still a Block, with the quota explanation', async () => {
    const v = await screenRecipient('a', guard)
    expect(v.decision).toBe('block')
    expect(v.explanation).toContain(QUOTA_MESSAGE)
  })
  it('sender: still a Block, with the quota explanation', async () => {
    const v = await screenSender('a', guard, {})
    expect(v.decision).toBe('block')
    expect(v.explanation).toContain(QUOTA_MESSAGE)
  })
  it('other API errors keep their own message', async () => {
    const g = { ...(guard as object), analyzeProgram: () => Promise.reject(new GuardError('SolSentry API 503', 503)) } as never
    const v = await screenRecipient('a', g)
    expect(v.explanation).toContain('503')
  })
})
