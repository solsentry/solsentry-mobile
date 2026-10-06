import type { RecipientVerdict } from '../guard/checks'
import { looksLikeName, parseName, resolveName, type NameTld, type ResolveDeps } from './names'
import { isPublicKey } from './solana-pay'

/** What the recipient field resolves to: the address that gets checked and paid. */
export type RecipientTarget =
  | { ok: true; address: string; name: { name: string; tld: NameTld; source: string } | null }
  | { ok: false; error: string; isName: boolean }

/**
 * Turn the recipient field into an address. A name is resolved fresh every time (no cache):
 * names are transferable, so the address is only good at the moment it is read.
 */
export async function resolveRecipientInput(input: string, deps: ResolveDeps): Promise<RecipientTarget> {
  const s = input.trim()
  if (parseName(s)) {
    const r = await resolveName(s, deps)
    if (!r.ok) return { ok: false, error: `Could not resolve ${r.name}: ${r.error}`, isName: true }
    return { ok: true, address: r.address, name: { name: r.name, tld: r.tld, source: r.source } }
  }
  if (looksLikeName(s)) return { ok: false, error: 'That name is not well formed.', isName: true }
  if (isPublicKey(s)) return { ok: true, address: s, name: null }
  return { ok: false, error: 'That is not a valid Solana address (base58, 32 bytes) or a name such as name.skr.', isName: false }
}

/** A name that cannot be resolved is a block with the reason (fail closed). */
export function nameBlockVerdict(error: string): RecipientVerdict {
  return {
    decision: 'block',
    reasons: ['NAME_UNRESOLVED'],
    explanation: `${error} Not sending (fail closed).`,
    risk_score: null,
  }
}
