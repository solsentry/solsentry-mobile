import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactReader } from '../src/alpenglow/artifact-reader'
import { EpochTable, MAINNET_POLICY } from '../src/alpenglow/verifier'

class FakeXHR {
  static last: FakeXHR
  responseType = ''
  timeout = 0
  withCredentials = false
  readyState = 0
  status = 200
  responseURL = ''
  response: ArrayBuffer = new ArrayBuffer(0)
  length: string | null = null
  aborted = false
  url = ''
  onreadystatechange = () => {}
  onprogress = (_: { loaded: number }) => {}
  onerror = () => {}
  ontimeout = () => {}
  onload = () => {}
  constructor() {
    FakeXHR.last = this
  }
  open(_method: string, url: string) {
    this.url = url
  }
  send() {}
  abort() {
    this.aborted = true
  }
  getResponseHeader() {
    return this.length
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Bounded native artifact reads', () => {
  it('requires HTTPS and confines the test HTTP exception to localhost', () => {
    for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
      expect(() => artifactReader(url, true)).toThrow()
    }
    expect(() => artifactReader('http://127.0.0.1:8093')).toThrow()
    expect(() => artifactReader('http://127.0.0.1:8093', true)).not.toThrow()
  })

  it('reads only the allowed artifact paths and rejects non-200 or redirected responses', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const reader = artifactReader('https://example.com/proofs')
    await expect(reader('../secret', { maxBytes: 10, signal: new AbortController().signal })).rejects.toThrow('path')
    const promise = reader('certificates/10.json', { maxBytes: 10, signal: new AbortController().signal })
    expect(FakeXHR.last.url).toBe('https://example.com/proofs/certificates/10.json')
    FakeXHR.last.response = new Uint8Array([1, 2]).buffer
    FakeXHR.last.onload()
    expect(await promise).toEqual(new Uint8Array([1, 2]))
    for (const setup of [
      (xhr: FakeXHR) => {
        xhr.status = 404
      },
      (xhr: FakeXHR) => {
        xhr.responseURL = 'https://another.example/certificates/10.json'
      },
    ]) {
      const p = reader('certificates/10.json', { maxBytes: 10, signal: new AbortController().signal })
      setup(FakeXHR.last)
      FakeXHR.last.onload()
      await expect(p).rejects.toThrow()
    }
  })

  it('aborts on excessive content length, download progress, response size or caller cancellation', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const reader = artifactReader('https://example.com')
    for (const setup of [
      (xhr: FakeXHR, _controller: AbortController) => {
        xhr.readyState = 2
        xhr.length = '1000'
        xhr.onreadystatechange()
      },
      (xhr: FakeXHR, _controller: AbortController) => xhr.onprogress({ loaded: 1000 }),
      (xhr: FakeXHR, _controller: AbortController) => {
        xhr.response = new ArrayBuffer(1000)
        xhr.onload()
      },
      (_xhr: FakeXHR, controller: AbortController) => controller.abort(),
    ]) {
      const controller = new AbortController()
      const p = reader('epochs/1082/table.bin', { maxBytes: 100, signal: controller.signal })
      setup(FakeXHR.last, controller)
      await expect(p).rejects.toThrow()
      expect(FakeXHR.last.aborted).toBe(true)
    }
  })

  it('cancels cooperative table preparation between batches', async () => {
    const raw = new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/alpenglow/table-1082.bin')))
    const controller = new AbortController()
    const p = EpochTable.loadAsync(raw, MAINNET_POLICY, [], controller.signal)
    controller.abort()
    await expect(p).rejects.toThrow('cancelled')
  })
})

it('excludes both diagnostic screens from normal Metro bundles', () => {
  const source = readFileSync(resolve(__dirname, '../metro.config.js'), 'utf8')
  for (const selftest of [false, true]) {
    const context = {
      __dirname: resolve(__dirname, '..'),
      module: { exports: {} as { resolver: { resolveRequest: Function } } },
      process: { env: { EXPO_PUBLIC_KYW_SELFTEST: selftest ? '1' : '0' } },
      require: () => ({ getDefaultConfig: () => ({ resolver: {} }) }),
    }
    runInNewContext(source, context)
    const resolver = context.module.exports.resolver.resolveRequest
    const fallback = { resolveRequest: (_: unknown, name: string) => ({ type: 'sourceFile', name }) }
    for (const name of ['@/src/kyw/selftest/SelfTestScreen', '@/src/alpenglow/selftest/CertificateScreen']) {
      expect(resolver(fallback, name, 'android').type).toBe(selftest ? 'sourceFile' : 'empty')
    }
  }
})
