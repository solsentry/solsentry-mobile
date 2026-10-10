import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { PublicKey } from '@solana/web3.js'
import { fetchWithTimeout } from '../guard/fetch-timeout'

/**
 * Name -> address resolution for the recipient field.
 *
 * - `.sns` / `.sol`: Solana Name Service via the official REST proxy (sdk-proxy-v2.sns.id,
 *   github.com/SolanaNameService/sns-sdk/tree/main/sdk-proxy). `/safe-resolve` is used so a
 *   `.sol` name only resolves when SNS and the new `.sol` registry agree. Since finalized slot
 *   452,825,395 SNS rejects `.sol` ("Unsupported TLD") until registry-backed `.sol` resolution
 *   ships; we surface that as a block with the reason, never fall back to the legacy path.
 * - `.skr` (Seeker ID, AllDomains ANS): one PDA derivation plus one getAccountInfo on mainnet,
 *   following Solana Mobile's seeker-domains skill
 *   (github.com/solana-mobile/solana-mobile-skills/tree/main/skills/seeker-domains).
 *
 * Every function here returns a result object and never throws: a name that cannot be resolved
 * is a block with a reason (fail closed). Forward results are never cached: a name is
 * transferable, so it is re-resolved before every check and again right before sending.
 */

export type NameTld = 'sol' | 'sns' | 'skr'

export interface ParsedName {
  /** Normalized full name, e.g. "alice.skr". */
  name: string
  tld: NameTld
  /** Name without the TLD, e.g. "alice" or "sub.alice". */
  label: string
}

export type NameResolution =
  | { ok: true; name: string; tld: NameTld; address: string; source: string }
  | { ok: false; name: string; error: string }

export interface ResolveDeps {
  /** Raw fetch; every call is wrapped in fetchWithTimeout, which also bounds the body read. */
  fetch: typeof fetch
  /** Mainnet RPC: .skr names live on mainnet whatever cluster the app targets. */
  rpcUrl: string
  snsProxyUrl?: string
  timeoutMs?: number
  now?: () => number
}

export const SNS_PROXY_URL = 'https://sdk-proxy-v2.sns.id'
export const NAME_TIMEOUT_MS = 8_000

const SNS_LABEL = /^[^\s./?#%\\]+$/u
const SKR_LABEL = /^[a-z0-9-]{1,63}$/

/** Is this input a name we try to resolve (rather than a base58 address)? */
export function parseName(input: string): ParsedName | null {
  const s = input.trim().toLowerCase()
  const m = /^(.+)\.(sol|sns|skr)$/.exec(s)
  if (!m) return null
  const label = m[1]
  const tld = m[2] as NameTld
  if (tld === 'skr') return SKR_LABEL.test(label) ? { name: s, tld, label } : null
  const parts = label.split('.')
  if (parts.length > 2 || !parts.every((p) => SNS_LABEL.test(p))) return null
  return { name: s, tld, label }
}

/** True when the input ends in a name suffix but is not a well-formed name. */
export function looksLikeName(input: string): boolean {
  return /\.(sol|sns|skr)$/i.test(input.trim())
}

function isAddress(s: unknown): s is string {
  if (typeof s !== 'string') return false
  try {
    return new PublicKey(s).toBase58() === s
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- SNS (.sns / .sol)

function boundedFetch(deps: ResolveDeps, what: string): typeof fetch {
  return fetchWithTimeout(deps.fetch, deps.timeoutMs ?? NAME_TIMEOUT_MS, what)
}

async function resolveSns(n: ParsedName, deps: ResolveDeps): Promise<NameResolution> {
  const base = deps.snsProxyUrl ?? SNS_PROXY_URL
  const url = `${base}/safe-resolve/${encodeURIComponent(n.name)}`
  const res = await boundedFetch(deps, 'SNS name lookup')(url)
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const env = body as { s?: unknown; result?: unknown } | null
  if (res.ok && env?.s === 'ok') {
    if (isAddress(env.result)) return { ok: true, name: n.name, tld: n.tld, address: env.result, source: 'SNS' }
    return { ok: false, name: n.name, error: 'SNS returned something that is not an address.' }
  }
  const msg = typeof env?.result === 'string' ? env.result : `HTTP ${res.status}`
  if (n.tld === 'sol' && /unsupported tld/i.test(msg)) {
    return {
      ok: false,
      name: n.name,
      error:
        'SNS is not resolving .sol names right now (registry migration: SNS stopped .sol lookups at slot 452,825,395). Paste the address instead.',
    }
  }
  if (res.status === 404) return { ok: false, name: n.name, error: `${n.name} is not registered.` }
  if (res.status === 409) return { ok: false, name: n.name, error: `${n.name} points to different addresses in SNS and the .sol registry.` }
  return { ok: false, name: n.name, error: `SNS lookup failed (${msg}).` }
}

// ---------------------------------------------------------------- .skr (AllDomains ANS)

export const ANS_PROGRAM = new PublicKey('ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK')
const TLD_HOUSE_PROGRAM = new PublicKey('TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S')
const NAME_HOUSE_PROGRAM = new PublicKey('NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51')
/** Derived from hash("ANS"); a test re-derives it as a self-check of the hashing and seed order. */
export const ROOT_ANS = new PublicKey('3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU')
const HASH_PREFIX = 'ALT Name Service'
const HEADER_SIZE = 200
const OWNER_OFFSET = 40
const EXPIRES_AT_OFFSET = 104
const ZERO_32 = new Uint8Array(32)

const pda = (program: PublicKey, seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0]

export function deriveAnsAccount(name: string, parent?: PublicKey): PublicKey {
  const hashed = sha256(utf8ToBytes(HASH_PREFIX + name))
  return pda(ANS_PROGRAM, [hashed, ZERO_32, parent ? parent.toBytes() : ZERO_32])
}

export function deriveSkrNameAccount(label: string): PublicKey {
  return deriveAnsAccount(label, deriveAnsAccount('.skr', ROOT_ANS))
}

function deriveSkrNftRecord(nameAccount: PublicKey): PublicKey {
  const tldHouse = pda(TLD_HOUSE_PROGRAM, [utf8ToBytes('tld_house'), utf8ToBytes('.skr')])
  const nameHouse = pda(NAME_HOUSE_PROGRAM, [utf8ToBytes('name_house'), tldHouse.toBytes()])
  return pda(NAME_HOUSE_PROGRAM, [utf8ToBytes('nft_record'), nameHouse.toBytes(), nameAccount.toBytes()])
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function resolveSkr(n: ParsedName, deps: ResolveDeps): Promise<NameResolution> {
  const nameAccount = deriveSkrNameAccount(n.label)
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [nameAccount.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
  })
  const res = await boundedFetch(deps, '.skr name lookup')(deps.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  if (!res.ok) return { ok: false, name: n.name, error: `Solana RPC refused the name lookup (HTTP ${res.status}).` }
  const json = (await res.json()) as {
    error?: { message?: string }
    result?: { value?: { owner?: string; data?: [string, string] } | null }
  }
  if (json?.error) return { ok: false, name: n.name, error: `Solana RPC error: ${json.error.message ?? 'unknown'}.` }
  const value = json?.result?.value
  if (value === null) return { ok: false, name: n.name, error: `${n.name} is not registered.` }
  if (!value || !Array.isArray(value.data)) return { ok: false, name: n.name, error: 'Solana RPC returned an unexpected response.' }
  if (value.owner !== ANS_PROGRAM.toBase58()) return { ok: false, name: n.name, error: 'The name account is not owned by the AllDomains program.' }
  const data = base64ToBytes(value.data[0])
  if (data.length < HEADER_SIZE) return { ok: false, name: n.name, error: 'The name account is malformed.' }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const expiresAt = Number(view.getBigUint64(EXPIRES_AT_OFFSET, true))
  const now = (deps.now ?? Date.now)()
  if (expiresAt !== 0 && expiresAt * 1000 < now) return { ok: false, name: n.name, error: `${n.name} has expired.` }

  const owner = new PublicKey(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32))
  if (owner.equals(deriveSkrNftRecord(nameAccount))) {
    // The real owner is whoever holds the domain NFT; resolving that needs three more RPC
    // reads and a supply check. No Seeker-issued .skr name is tokenized today, so refuse.
    return { ok: false, name: n.name, error: `${n.name} is a tokenized domain; this app does not resolve those yet.` }
  }
  return { ok: true, name: n.name, tld: 'skr', address: owner.toBase58(), source: 'AllDomains (.skr)' }
}

// ---------------------------------------------------------------- entry point

/** Resolve a name to an address. Never throws; any failure is `{ ok: false, error }`. */
export async function resolveName(input: string, deps: ResolveDeps): Promise<NameResolution> {
  const n = parseName(input)
  if (!n) return { ok: false, name: input.trim(), error: 'That is not a name this app can resolve (.sol, .sns or .skr).' }
  try {
    return n.tld === 'skr' ? await resolveSkr(n, deps) : await resolveSns(n, deps)
  } catch (err) {
    return { ok: false, name: n.name, error: `Name lookup failed (${(err as Error)?.message ?? 'unknown error'}).` }
  }
}
