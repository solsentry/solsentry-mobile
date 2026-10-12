export const RPC_TIMEOUT_MS = 10_000

/**
 * fetch that gives up after `ms`, counting the response BODY too: the body is read inside the
 * deadline and handed back as a buffered Response. A server that sends headers and then stalls
 * becomes an error (-> Block), not a frozen screen.
 */
export function fetchWithTimeout(base: typeof fetch, ms: number = RPC_TIMEOUT_MS, what = 'RPC request'): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`))
      }, ms)
    })
    const buffered = base(input, { ...init, signal: ctrl.signal }).then(
      async (res) =>
        new Response(await res.text(), { status: res.status, statusText: res.statusText, headers: res.headers }),
    )
    return Promise.race([buffered, timeout]).finally(() => clearTimeout(timer))
  }) as typeof fetch
}
