import { describe, expect, it } from 'vitest'
import { PROVIDER_CHOICES, resolveEndpoint, rpcUrlHost } from '../src/kyw/providers'

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
