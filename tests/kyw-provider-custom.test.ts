import { describe, expect, it } from 'vitest'
import { PROVIDER_CHOICES, loadedProvider, resolveEndpoint, rpcUrlDigest, rpcUrlHost } from '../src/kyw/providers'

describe('your own RPC URL', () => {
  it('offers only SolSentry and the user URL', () => {
    expect(PROVIDER_CHOICES).toEqual(['solsentry', 'custom'])
  })
  it('reports only the host; the key in the path or query stays in the url', () => {
    const url = 'https://my-node.example-rpc.com/v1/secret-token?api-key=abc'
    expect(resolveEndpoint('custom', ` ${url} `, 'api.solsentry.app')).toEqual({ ok: true, kind: 'direct', url, host: 'my-node.example-rpc.com' })
  })
  it('refuses http, credentials in the authority and anything that is not a URL', () => {
    for (const bad of ['http://rpc.example.com', 'https://user:pw@rpc.example.com', 'rpc.example.com', 'https://localhost', '', 'https://rpc.example.com bad'])
      expect(rpcUrlHost(bad)).toBeNull()
    expect(resolveEndpoint('custom', '', 'api.solsentry.app').ok).toBe(false)
  })
})

describe('a provider saved by an older version', () => {
  it('keeps the two choices the app offers, with or without a URL', () => {
    expect(loadedProvider('solsentry', undefined)).toBe('solsentry')
    expect(loadedProvider('custom', undefined)).toBe('custom')
  })
  it('keeps a named provider whose key is saved', () => {
    expect(loadedProvider('helius', 'abc')).toBe('helius')
  })
  it('falls back to SolSentry for a named provider with no key, so the phone does not sit idle', () => {
    expect(loadedProvider('helius', undefined)).toBe('solsentry')
    expect(loadedProvider('quicknode', '  ')).toBe('solsentry')
  })
})

describe('rpcUrlDigest', () => {
  it('hashes the exact endpoint string under its domain (server contract kyw-rpc-url-v0)', () => {
    expect(rpcUrlDigest('https://rpc.example.com/?api-key=abc')).toBe('ee5ad800aa9a63d0122daefe545b61d82673aa45013ebd9d0f85eff75e2e4e92')
    expect(rpcUrlDigest('https://rpc.example.com/?api-key=abd')).not.toBe('ee5ad800aa9a63d0122daefe545b61d82673aa45013ebd9d0f85eff75e2e4e92')
  })
})
