// RPC choices for the validation read. No SolSentry key lives in the app: the default goes through
// the SolSentry server (which only reads the open task); the others use a key the user pastes.
// A key or endpoint token never leaves the phone except inside the request to that provider.

export type ProviderId = 'solsentry' | 'helius' | 'quicknode' | 'solami'

export interface ProviderInfo {
  id: ProviderId
  label: string
  beta: boolean
  /** What the user pastes. null: nothing to paste. */
  secretLabel: string | null
  secretHint: string | null
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'solsentry', label: 'SolSentry (default)', beta: false, secretLabel: null, secretHint: null },
  { id: 'helius', label: 'Helius', beta: true, secretLabel: 'Helius API key', secretHint: 'Paste your API key' },
  {
    id: 'quicknode',
    label: 'QuickNode',
    beta: true,
    secretLabel: 'QuickNode endpoint URL',
    secretHint: 'https://<name>.solana-mainnet.quiknode.pro/<token>/',
  },
  { id: 'solami', label: 'Solami', beta: true, secretLabel: 'Solami API key', secretHint: 'Paste your API key' },
]

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

export type Endpoint =
  | { ok: true; kind: 'proxy'; host: string }
  /** `url` carries the secret; `host` is the only part that may be reported. */
  | { ok: true; kind: 'direct'; url: string; host: string }
  | { ok: false; problem: string }

const KEY_SHAPE = /^[A-Za-z0-9._-]{8,200}$/

/** Resolve where the read goes. `apiHost` is the host of the SolSentry API in this build. */
export function resolveEndpoint(id: ProviderId, secret: string, apiHost: string): Endpoint {
  if (id === 'solsentry') return { ok: true, kind: 'proxy', host: apiHost }
  const value = secret.trim()
  if (!value) return { ok: false, problem: `Add your ${providerInfo(id).secretLabel} below.` }
  if (id === 'helius') {
    if (!KEY_SHAPE.test(value)) return { ok: false, problem: 'That does not look like a Helius API key.' }
    return {
      ok: true,
      kind: 'direct',
      url: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(value)}`,
      host: 'mainnet.helius-rpc.com',
    }
  }
  if (id === 'solami') {
    if (!KEY_SHAPE.test(value)) return { ok: false, problem: 'That does not look like a Solami API key.' }
    return {
      ok: true,
      kind: 'direct',
      url: `https://rpc.solami.dev/solana?api-key=${encodeURIComponent(value)}`,
      host: 'rpc.solami.dev',
    }
  }
  // QuickNode: the endpoint name and the token are both in the URL the dashboard shows.
  const m = /^https:\/\/([a-z0-9-]+)\.((?:[a-z0-9-]+\.)*quiknode\.pro)(\/[A-Za-z0-9._~\/-]*)?$/.exec(value)
  if (!m) return { ok: false, problem: 'Paste the HTTPS endpoint URL from your QuickNode dashboard.' }
  // The first label is the user's endpoint name: leave it out of what gets reported.
  return { ok: true, kind: 'direct', url: value, host: m[2] }
}
