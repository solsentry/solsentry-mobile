import { describe, expect, it } from 'vitest'
import { missingCapabilities } from '../src/kyw/copy'
import { ownRpcNoResultStreak } from '../src/kyw/history'
import { cannotVerify, type Capability, type ProbeReport } from '../src/kyw/probe'
import type { TaskRecord } from '../src/kyw/types'

const full: Capability = { class: 'full', ms: 100 }
const report = (C1: Capability, rest: Partial<ProbeReport['capabilities']> = {}): ProbeReport => ({
  probe_version: '0',
  rpc_host: 'rpc.example.com',
  measured_at: '2026-10-24T06:00:00.000Z',
  capabilities: { C1, C2: full, C3: full, C4: full, C5: full, C6: { min_interval_ms: 250 }, ...rest },
  client: { kind: 'android', version: '0.1.24' },
})

describe('an RPC that cannot verify', () => {
  it('is one that cannot read a recent transaction for a lasting reason', () => {
    expect(cannotVerify(report({ class: 'none', reason: 'not_available' }))).toBe(true)
    expect(cannotVerify(report({ class: 'none', reason: 'http_error' }))).toBe(true)
    expect(cannotVerify(report({ class: 'none', reason: 'timeout' }))).toBe(false)
    expect(cannotVerify(report({ class: 'none', reason: 'rpc_error' }))).toBe(false)
    expect(cannotVerify(report({ class: 'rate_limited', reason: 'rate_limited' }))).toBe(false)
    expect(cannotVerify(report(full))).toBe(false)
    expect(cannotVerify(null)).toBe(false)
  })
  it('names what keeps a partial RPC from the bonus', () => {
    expect(missingCapabilities(report(full, { C2: { class: 'none', reason: 'not_available' } }))).toBe('old transactions is not full')
    expect(missingCapabilities(report(full, { C3: { class: 'none', reason: 'rpc_error' }, C6: { min_interval_ms: null } }))).toBe('address history (first page), safe pace are not full')
  })
})

describe('own-RPC no-result streak', () => {
  const rec = (provider: TaskRecord['provider'], verdict: TaskRecord['verdict']) => ({ provider, verdict }) as TaskRecord
  it('counts the newest tasks in a row with no result on that RPC only', () => {
    const records = [rec('custom', 'unknown'), rec('custom', 'accepted'), rec('custom', 'unknown'), rec('custom', 'unknown')]
    expect(ownRpcNoResultStreak(records, 'custom')).toBe(2)
    expect(ownRpcNoResultStreak([...records, rec('solsentry', 'unknown')], 'custom')).toBe(0)
    expect(ownRpcNoResultStreak(records, 'solsentry')).toBe(0)
  })
})
