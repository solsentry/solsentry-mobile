import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { PublicKey } from '@solana/web3.js'
import { fetchWithTimeout } from '../guard/service'

/**
 * Name -> address resolution for the recipient field.
 *
 * - `.sns` / `.sol`: Solana Name Service via the official REST proxy (sdk-proxy-v2.sns.id,
 *   github.com/SolanaNameService/sns-sdk/tree/main/sdk-proxy). `/safe-resolve` is used so a
 *   `.sol` name only resolves when SNS and the new `.sol` registry agree. Since finalized slot
 *   452,825,395 SNS rejects `.sol` ("Unsupported TLD") until registry-backed `.sol` resolution
 *   ships; we surface that as a block with the reason, never fall back to the legacy path.
 * - `.skr` (Seeker ID) and every other AllDomains (ANS) TLD: PDA derivation plus account reads on
 *   mainnet, following Solana Mobile's seeker-domains skill
 *   (github.com/solana-mobile/solana-mobile-skills/tree/main/skills/seeker-domains). The derivation
 *   is the same for every TLD; a TLD other than `.skr` is only accepted when its TLD house exists
 *   on chain and binds to the derived TLD account (read in the same call as the name).
 *
 * Every function here returns a result object and never throws: a name that cannot be resolved
 * is a block with a reason (fail closed). Forward results are never cached: a name is
 * transferable, so it is re-resolved before every check and again right before sending.
 */

/** "sol" / "sns" (SNS) or an AllDomains TLD such as "skr", "bonk", "superteam". */
export type NameTld = string

export interface ParsedName {
  /** Normalized full name, e.g. "alice.skr". */
  name: string
  tld: NameTld
  /** Name without the TLD, e.g. "alice" or "sub.alice". */
  label: string
}

export type NameResolution =
  { ok: true; name: string; tld: NameTld; address: string; source: string } | { ok: false; name: string; error: string }

export interface ResolveDeps {
  /** Raw fetch; every call is wrapped in fetchWithTimeout, which also bounds the body read. */
  fetch: typeof fetch
  /** Mainnet RPC: AllDomains names live on mainnet whatever cluster the app targets. */
  rpcUrl: string
  snsProxyUrl?: string
  timeoutMs?: number
  now?: () => number
}

export const SNS_PROXY_URL = 'https://sdk-proxy-v2.sns.id'
export const NAME_TIMEOUT_MS = 8_000

const SNS_TLDS = new Set(['sol', 'sns'])
const SNS_LABEL = /^[^\s./?#%\\]+$/u
/** ASCII only: emoji / unicode labels exist on chain but have no normalization rule we can trust. */
const ANS_LABEL = /^[a-z0-9-]{1,63}$/
const TLD_RE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * AllDomains TLDs that shadow another naming system. A name there is a valid AllDomains name,
 * but someone typing it expects the other system's owner (ENS, a web domain), so a payment would
 * go to whoever registered the look-alike on Solana. Refused before any RPC call.
 */
export const ANS_SHADOWED_TLDS: Readonly<Record<string, string>> = {
  eth: 'an ENS name',
  btc: 'a Bitcoin name',
  com: 'a web domain',
  io: 'a web domain',
  id: 'a web domain',
  xyz: 'a web domain',
  gg: 'a web domain',
  trade: 'a web domain',
}

/** Is this input a name we try to resolve (rather than a base58 address)? */
export function parseName(input: string): ParsedName | null {
  const s = input.trim().toLowerCase()
  const dot = s.lastIndexOf('.')
  if (dot <= 0) return null
  const label = s.slice(0, dot)
  const tld = s.slice(dot + 1)
  if (!TLD_RE.test(tld)) return null
  if (!SNS_TLDS.has(tld)) return ANS_LABEL.test(label) ? { name: s, tld, label } : null
  const parts = label.split('.')
  if (parts.length > 2 || !parts.every((p) => SNS_LABEL.test(p))) return null
  return { name: s, tld, label }
}

/** True when the input ends in a name-like suffix but is not a well-formed name. */
export function looksLikeName(input: string): boolean {
  return /\.[^\s.]+$/u.test(input.trim())
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

// ---------------------------------------------------------------- AllDomains ANS (.skr, .bonk, ...)

export const ANS_PROGRAM = new PublicKey('ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK')
export const TLD_HOUSE_PROGRAM = new PublicKey('TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S')
const NAME_HOUSE_PROGRAM = new PublicKey('NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51')
/** Derived from hash("ANS"); a test re-derives it as a self-check of the hashing and seed order. */
export const ROOT_ANS = new PublicKey('3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU')
const HASH_PREFIX = 'ALT Name Service'
const HEADER_SIZE = 200
const OWNER_OFFSET = 40
const EXPIRES_AT_OFFSET = 104
/** TldHouse layout (onsol-labs/tld-parser): 8 discriminator, 2 x 32 keys, parent (32), then the TLD as u32 len + NUL-padded utf8. */
const TLD_HOUSE_PARENT_OFFSET = 72
const TLD_HOUSE_TLD_OFFSET = 104
const ZERO_32 = new Uint8Array(32)

const pda = (program: PublicKey, seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0]

export function deriveAnsAccount(name: string, parent?: PublicKey): PublicKey {
  const hashed = sha256(utf8ToBytes(HASH_PREFIX + name))
  return pda(ANS_PROGRAM, [hashed, ZERO_32, parent ? parent.toBytes() : ZERO_32])
}

/** The TLD's own name account (parent of every name in it), e.g. ".bonk" under the ANS root. */
export function deriveTldAccount(tld: string): PublicKey {
  return deriveAnsAccount(`.${tld}`, ROOT_ANS)
}

export function deriveTldHouse(tld: string): PublicKey {
  return pda(TLD_HOUSE_PROGRAM, [utf8ToBytes('tld_house'), utf8ToBytes(`.${tld}`)])
}

export function deriveNameAccount(label: string, tld: string): PublicKey {
  return deriveAnsAccount(label, deriveTldAccount(tld))
}

export function deriveSkrNameAccount(label: string): PublicKey {
  return deriveNameAccount(label, 'skr')
}

function deriveNftRecord(nameAccount: PublicKey, tldHouse: PublicKey): PublicKey {
  const nameHouse = pda(NAME_HOUSE_PROGRAM, [utf8ToBytes('name_house'), tldHouse.toBytes()])
  return pda(NAME_HOUSE_PROGRAM, [utf8ToBytes('nft_record'), nameHouse.toBytes(), nameAccount.toBytes()])
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

type RpcAccount = { owner?: string; data?: [string, string] } | null

/** One JSON-RPC call; a transport, HTTP or RPC error comes back as `{ error }`. */
async function rpcCall(
  deps: ResolveDeps,
  what: string,
  method: string,
  params: unknown[],
): Promise<{ result: unknown } | { error: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const res = await boundedFetch(deps, what)(deps.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  if (!res.ok) return { error: `Solana RPC refused the name lookup (HTTP ${res.status}).` }
  const json = (await res.json()) as { error?: { message?: string }; result?: unknown }
  if (json?.error) return { error: `Solana RPC error: ${json.error.message ?? 'unknown'}.` }
  return { result: json?.result }
}

/** Decode a name account into its owner, or the reason it cannot be paid. */
function ownerFromNameAccount(
  n: ParsedName,
  value: RpcAccount | undefined,
  nameAccount: PublicKey,
  tldHouse: PublicKey,
  deps: ResolveDeps,
): NameResolution {
  if (value === null) return { ok: false, name: n.name, error: `${n.name} is not registered.` }
  if (!value || !Array.isArray(value.data))
    return { ok: false, name: n.name, error: 'Solana RPC returned an unexpected response.' }
  if (value.owner !== ANS_PROGRAM.toBase58())
    return { ok: false, name: n.name, error: 'The name account is not owned by the AllDomains program.' }
  const data = base64ToBytes(value.data[0])
  if (data.length < HEADER_SIZE) return { ok: false, name: n.name, error: 'The name account is malformed.' }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const expiresAt = Number(view.getBigUint64(EXPIRES_AT_OFFSET, true))
  const now = (deps.now ?? Date.now)()
  if (expiresAt !== 0 && expiresAt * 1000 < now) return { ok: false, name: n.name, error: `${n.name} has expired.` }

  const owner = new PublicKey(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32))
  if (owner.equals(deriveNftRecord(nameAccount, tldHouse))) {
    // The real owner is whoever holds the domain NFT; resolving that needs three more RPC reads
    // and a supply check, and the holder can be a marketplace escrow. Refuse instead.
    return { ok: false, name: n.name, error: `${n.name} is a tokenized domain; this app does not resolve those yet.` }
  }
  return { ok: true, name: n.name, tld: n.tld, address: owner.toBase58(), source: `AllDomains (.${n.tld})` }
}

/** .skr: the TLD is pinned (measured on mainnet), so one getAccountInfo on the name account. */
async function resolveSkr(n: ParsedName, deps: ResolveDeps): Promise<NameResolution> {
  const nameAccount = deriveSkrNameAccount(n.label)
  const r = await rpcCall(deps, '.skr name lookup', 'getAccountInfo', [
    nameAccount.toBase58(),
    { encoding: 'base64', commitment: 'confirmed' },
  ])
  if ('error' in r) return { ok: false, name: n.name, error: r.error }
  const value = (r.result as { value?: RpcAccount } | undefined)?.value
  return ownerFromNameAccount(n, value, nameAccount, deriveTldHouse('skr'), deps)
}

/** Is `house` the on-chain TldHouse for `.tld`, bound to the derived TLD account `tldAccount`? */
function tldHouseMatches(house: RpcAccount | undefined, tld: string, tldAccount: PublicKey): boolean {
  if (!house || !Array.isArray(house.data) || house.owner !== TLD_HOUSE_PROGRAM.toBase58()) return false
  const d = base64ToBytes(house.data[0])
  if (d.length < TLD_HOUSE_TLD_OFFSET + 4) return false
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(TLD_HOUSE_TLD_OFFSET, true)
  // Stored NUL-padded (live .bonk: len 10, ".bonk" + 5 zero bytes); tld-parser strips the padding too.
  let end = Math.min(TLD_HOUSE_TLD_OFFSET + 4 + len, d.length)
  while (end > TLD_HOUSE_TLD_OFFSET + 4 && d[end - 1] === 0) end--
  const name = d.subarray(TLD_HOUSE_TLD_OFFSET + 4, end)
  return (
    sameBytes(name, utf8ToBytes(`.${tld}`)) &&
    sameBytes(d.subarray(TLD_HOUSE_PARENT_OFFSET, TLD_HOUSE_PARENT_OFFSET + 32), tldAccount.toBytes())
  )
}

/** Is `parent` the ANS account for the TLD, owned (header owner field) by its TldHouse? */
function tldAccountMatches(parent: RpcAccount | undefined, tldHouse: PublicKey): boolean {
  if (!parent || !Array.isArray(parent.data) || parent.owner !== ANS_PROGRAM.toBase58()) return false
  const d = base64ToBytes(parent.data[0])
  return d.length >= HEADER_SIZE && sameBytes(d.subarray(OWNER_OFFSET, OWNER_OFFSET + 32), tldHouse.toBytes())
}

/** Any other AllDomains TLD: TLD house, TLD account and name account in one getMultipleAccounts. */
async function resolveAns(n: ParsedName, deps: ResolveDeps): Promise<NameResolution> {
  const unsupported = { ok: false as const, name: n.name, error: `Name system not supported: .${n.tld}` }
  const shadowed = ANS_SHADOWED_TLDS[n.tld]
  if (shadowed) {
    return { ...unsupported, error: `${unsupported.error} (an AllDomains .${n.tld} name is not ${shadowed}).` }
  }
  const tldHouse = deriveTldHouse(n.tld)
  const tldAccount = deriveTldAccount(n.tld)
  const nameAccount = deriveAnsAccount(n.label, tldAccount)
  const r = await rpcCall(deps, 'Name lookup', 'getMultipleAccounts', [
    [tldHouse.toBase58(), tldAccount.toBase58(), nameAccount.toBase58()],
    { encoding: 'base64', commitment: 'confirmed' },
  ])
  if ('error' in r) return { ok: false, name: n.name, error: r.error }
  const value = (r.result as { value?: unknown } | undefined)?.value
  if (!Array.isArray(value) || value.length !== 3) {
    return { ok: false, name: n.name, error: 'Solana RPC returned an unexpected response.' }
  }
  const [house, parent, name] = value as RpcAccount[]
  if (!tldHouseMatches(house, n.tld, tldAccount) || !tldAccountMatches(parent, tldHouse)) {
    return { ...unsupported, error: `${unsupported.error}.` }
  }
  return ownerFromNameAccount(n, name, nameAccount, tldHouse, deps)
}

// ---------------------------------------------------------------- entry point

/** Resolve a name to an address. Never throws; any failure is `{ ok: false, error }`. */
export async function resolveName(input: string, deps: ResolveDeps): Promise<NameResolution> {
  const n = parseName(input)
  if (!n) return { ok: false, name: input.trim(), error: 'That is not a name this app can resolve.' }
  try {
    if (SNS_TLDS.has(n.tld)) return await resolveSns(n, deps)
    return n.tld === 'skr' ? await resolveSkr(n, deps) : await resolveAns(n, deps)
  } catch (err) {
    return { ok: false, name: n.name, error: `Name lookup failed (${(err as Error)?.message ?? 'unknown error'}).` }
  }
}
