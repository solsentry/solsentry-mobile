import { requireValue } from './codec'
import type { ReadArtifact } from './client'

/** Native XHR progress aborts oversized downloads before parsing. */
export function artifactReader(baseUrl: string, allowLocalhostHttp = false): ReadArtifact {
  const base = new URL(baseUrl)
  requireValue(
    !base.username && !base.password && !base.search && !base.hash,
    'Artifact URL must not contain credentials or query parameters',
  )
  requireValue(
    base.protocol === 'https:' ||
      (allowLocalhostHttp && base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)),
    'HTTPS artifact URL required',
  )
  base.pathname = base.pathname.replace(/\/$/, '') + '/'
  return (path, { maxBytes, signal }) =>
    new Promise((resolve, reject) => {
      requireValue(/^(certificates\/\d+\.json|epochs\/\d+\/table\.bin)$/.test(path), 'Artifact path')
      if (signal.aborted) {
        reject(new Error('Artifact request cancelled'))
        return
      }
      const xhr = new XMLHttpRequest()
      let settled = false
      const finish = (error?: Error, data?: Uint8Array) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        if (error) {
          xhr.abort()
          reject(error)
        } else resolve(data!)
      }
      const cancel = () => finish(new Error('Artifact request cancelled'))
      xhr.open('GET', new URL(path, base).href)
      xhr.responseType = 'arraybuffer'
      xhr.timeout = 60000
      xhr.withCredentials = false
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 2) return
        const length = xhr.getResponseHeader('Content-Length')
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) finish(new Error('Artifact response size'))
      }
      xhr.onprogress = (event) => {
        if (event.loaded > maxBytes) finish(new Error('Artifact response size'))
      }
      xhr.onerror = () => finish(new Error('Artifact network error'))
      xhr.ontimeout = () => finish(new Error('Artifact request timed out'))
      xhr.onload = () => {
        if (settled) return
        if (xhr.status !== 200) {
          finish(new Error(`Artifact HTTP ${xhr.status}`))
          return
        }
        try {
          if (xhr.responseURL && new URL(xhr.responseURL).origin !== base.origin) {
            finish(new Error('Cross-origin artifact redirect'))
            return
          }
        } catch {
          finish(new Error('Invalid artifact redirect'))
          return
        }
        if (!(xhr.response instanceof ArrayBuffer) || xhr.response.byteLength > maxBytes) {
          finish(new Error('Artifact response size/type'))
          return
        }
        finish(undefined, new Uint8Array(xhr.response))
      }
      signal.addEventListener('abort', cancel, { once: true })
      xhr.send()
    })
}
