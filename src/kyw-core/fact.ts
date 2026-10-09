// `tx.core` fact, spec_version "0". Mirrors integrations/kyw/fact.py of the SolSentry server:
// the deterministic part of a getTransaction response read with READ_PARAMS. A client is correct
// only when it reproduces tests/fixtures/kyw_tx_core/manifest.json for every vector.
import { FactError, canonicalJson, compareCodePoints, factDigest } from './canonical'
import { Num, ParseError, has, isObj, parseLossless, type Obj, type Value } from './lossless'

export const FACT_TYPE = 'tx.core'
export const SPEC_VERSION = '0'
export const READ_PARAMS = {
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 1,
  commitment: 'finalized',
} as const

export type UnknownReason =
  'not_available' | 'rpc_error' | 'rate_limited' | 'version' | 'timeout' | 'invalid_response'

export type ReadOutcome =
  | { status: 'ok'; unknownReason: null; fact: Obj; factDigest: string; failed: boolean }
  | { status: 'unknown'; unknownReason: UnknownReason; fact: null; factDigest: null; failed: null }

function unknown(unknownReason: UnknownReason): ReadOutcome {
  return { status: 'unknown', unknownReason, fact: null, factDigest: null, failed: null }
}

/** `container[key]` on a required key. */
function need(container: Value | undefined, key: string): Value {
  if (!isObj(container) || !has(container, key)) throw new FactError(`missing ${key}`)
  return container[key]
}

/** `container.get(key)`: null when the key is absent. */
function opt(container: Value | undefined, key: string): Value {
  if (!isObj(container)) throw new FactError(`${key}: not an object`)
  return has(container, key) ? container[key] : null
}

function list(value: Value | undefined, what: string): Value[] {
  if (!Array.isArray(value)) throw new FactError(`${what}: not a list`)
  return value
}

/** Python truthiness of a JSON value: null, false, zero and anything empty are falsy. */
function falsy(value: Value): boolean {
  if (value === null || value === false || value === '') return true
  if (value instanceof Num) return Number(value.raw) === 0
  if (Array.isArray(value)) return value.length === 0
  return isObj(value) && Object.keys(value).length === 0
}

/** `value or []`. */
function orEmptyList(value: Value, what: string): Value[] {
  return falsy(value) ? [] : list(value, what)
}

function sameValue(a: Value, b: Value): boolean {
  if (a instanceof Num || b instanceof Num) {
    return a instanceof Num && b instanceof Num && Number(a.raw) === Number(b.raw) && a.isInt === b.isInt
      ? !a.isInt || BigInt(a.raw) === BigInt(b.raw)
      : false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => has(b, k) && sameValue(a[k], b[k]))
  }
  return a === b
}

function compareIndex(a: Value, b: Value): number {
  if (a instanceof Num && b instanceof Num && a.isInt && b.isInt) {
    const x = BigInt(a.raw)
    const y = BigInt(b.raw)
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (typeof a === 'string' && typeof b === 'string') return compareCodePoints(a, b)
  throw new FactError('inner instruction index is not comparable')
}

/** Build the `tx.core` fact from a non-null getTransaction result. */
export function txCore(result: Value): Obj {
  const meta = need(result, 'meta')
  const message = need(need(result, 'transaction'), 'message')

  const loadedRaw = opt(meta, 'loadedAddresses')
  if (!falsy(loadedRaw) && !isObj(loadedRaw)) throw new FactError('loadedAddresses: not an object')
  const side = (name: string): Value[] =>
    isObj(loadedRaw) && has(loadedRaw, name) ? list(loadedRaw[name], name) : []
  const loadedKeys = [...side('writable'), ...side('readonly')]

  const entries = list(need(message, 'accountKeys'), 'accountKeys')
  // jsonParsed already expands lookup-table keys and tags them source=lookupTable.
  const keys: Value[] = entries.map((entry) => (isObj(entry) ? need(entry, 'pubkey') : entry))
  const hasLookup = entries.some((entry) => isObj(entry) && has(entry, 'source') && entry.source === 'lookupTable')
  if (loadedKeys.length > 0 && !hasLookup) {
    const preBalances = need(meta, 'preBalances')
    const tail = keys.slice(Math.max(0, keys.length - loadedKeys.length))
    const alreadyExpanded =
      keys.length === list(preBalances, 'preBalances').length && sameValue(tail, loadedKeys)
    if (!alreadyExpanded) keys.push(...loadedKeys)
  }

  const program = (instruction: Value): Value => {
    if (!isObj(instruction)) throw new FactError('instruction: not an object')
    if (has(instruction, 'programId')) return instruction.programId
    const index = need(instruction, 'programIdIndex')
    if (!(index instanceof Num) || !index.isInt) throw new FactError('programIdIndex: not an integer')
    let at = Number(BigInt(index.raw))
    if (at < 0) at += keys.length
    if (!(at >= 0 && at < keys.length)) throw new FactError('programIdIndex: out of range')
    return keys[at]
  }

  const tokens = (name: string): Value[] => {
    const balances = orEmptyList(opt(meta, name), name).map((entry) => {
      const amount = need(need(entry, 'uiTokenAmount'), 'amount')
      if (typeof amount !== 'string') throw new FactError('token amount must be a string')
      const balance: Obj = Object.create(null)
      balance.accountIndex = need(entry, 'accountIndex')
      balance.mint = need(entry, 'mint')
      balance.owner = opt(entry, 'owner')
      balance.amount = amount
      return { balance, key: canonicalJson(balance) }
    })
    return balances.sort((a, b) => compareCodePoints(a.key, b.key)).map((b) => b.balance)
  }

  const factMeta: Obj = Object.create(null)
  factMeta.fee = need(meta, 'fee')
  factMeta.preBalances = need(meta, 'preBalances')
  factMeta.postBalances = need(meta, 'postBalances')
  factMeta.preTokenBalances = tokens('preTokenBalances')
  factMeta.postTokenBalances = tokens('postTokenBalances')

  const fact: Obj = Object.create(null)
  fact.slot = need(result, 'slot')
  fact.blockTime = opt(result, 'blockTime')
  fact.failed = need(meta, 'err') !== null
  fact.meta = factMeta
  fact.accountKeys = keys
  fact.instructions = list(need(message, 'instructions'), 'instructions').map(program)
  fact.innerInstructions = orEmptyList(opt(meta, 'innerInstructions'), 'innerInstructions')
    .map((group) => ({ group, index: need(group, 'index') }))
    .sort((a, b) => compareIndex(a.index, b.index))
    .map(({ group, index }) => {
      const out: Obj = Object.create(null)
      out.index = index
      out.programIds = list(need(group, 'instructions'), 'inner instructions').map(program)
      return out
    })
  return fact
}

/**
 * Turn a raw JSON-RPC getTransaction body (the response text, untouched) into an outcome.
 * A null result is unknown/not_available, never an empty fact.
 */
export function readOutcome(rawBody: string): ReadOutcome {
  let response: Value
  try {
    response = parseLossless(rawBody)
  } catch (e) {
    if (e instanceof ParseError) return unknown('invalid_response')
    throw e
  }
  if (!isObj(response)) return unknown('invalid_response')
  if (has(response, 'error')) {
    const error = response.error
    const rawMessage = isObj(error) && has(error, 'message') ? error.message : ''
    const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : ''
    const code = isObj(error) && has(error, 'code') ? error.code : null
    if (message.includes('version')) return unknown('version')
    if ((code instanceof Num && Number(code.raw) === 429) || message.includes('rate')) return unknown('rate_limited')
    return unknown('rpc_error')
  }
  const result = has(response, 'result') ? response.result : null
  if (result === null) return unknown('not_available')
  try {
    const fact = txCore(result)
    return { status: 'ok', unknownReason: null, fact, factDigest: factDigest(fact), failed: fact.failed === true }
  } catch (e) {
    if (e instanceof FactError || e instanceof RangeError || e instanceof SyntaxError) {
      return unknown('invalid_response')
    }
    throw e
  }
}
