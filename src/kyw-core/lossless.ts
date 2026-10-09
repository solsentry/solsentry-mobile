// Lossless JSON for the KYW fact. JSON.parse cannot be used on an RPC body: it rounds integers
// above 2^53 and turns `5000.0` into `5000`, so a float could not be told from an integer.
// Numbers keep their source text; nothing here imports React Native.

/** A JSON number exactly as written in the source. */
export class Num {
  readonly raw: string
  /** True when the literal has no fraction and no exponent. */
  readonly isInt: boolean

  constructor(raw: string, isInt: boolean) {
    this.raw = raw
    this.isInt = isInt
  }
}

export type Obj = { [key: string]: Value }
export type Value = null | boolean | string | Num | Value[] | Obj

export class ParseError extends Error {}

const MAX_DEPTH = 256

export function isObj(v: Value | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Num)
}

export function has(o: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

/** Strict RFC 8259 parse. A duplicate key keeps the last value. */
export function parseLossless(text: string): Value {
  let i = 0
  const n = text.length

  const fail = (what: string): never => {
    throw new ParseError(`${what} at ${i}`)
  }

  const skip = () => {
    for (;;) {
      const c = text.charCodeAt(i)
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++
      else return
    }
  }

  const literal = (word: string, value: null | boolean): null | boolean => {
    if (text.startsWith(word, i)) {
      i += word.length
      return value
    }
    return fail('unexpected token')
  }

  const digits = (): number => {
    const start = i
    for (;;) {
      const c = text.charCodeAt(i)
      if (c >= 0x30 && c <= 0x39) i++
      else break
    }
    return i - start
  }

  const number = (): Num => {
    const start = i
    let isInt = true
    if (text[i] === '-') i++
    if (text[i] === '0') i++
    else if (digits() === 0) fail('bad number')
    if (text[i] === '.') {
      isInt = false
      i++
      if (digits() === 0) fail('bad number')
    }
    if (text[i] === 'e' || text[i] === 'E') {
      isInt = false
      i++
      if (text[i] === '+' || text[i] === '-') i++
      if (digits() === 0) fail('bad number')
    }
    return new Num(text.slice(start, i), isInt)
  }

  const string = (): string => {
    i++ // opening quote
    let out = ''
    let start = i
    for (;;) {
      if (i >= n) fail('unterminated string')
      const c = text.charCodeAt(i)
      if (c === 0x22) {
        out += text.slice(start, i)
        i++
        return out
      }
      if (c < 0x20) fail('control character in string')
      if (c !== 0x5c) {
        i++
        continue
      }
      out += text.slice(start, i)
      const e = text[i + 1]
      i += 2
      if (e === '"' || e === '\\' || e === '/') out += e
      else if (e === 'b') out += '\b'
      else if (e === 'f') out += '\f'
      else if (e === 'n') out += '\n'
      else if (e === 'r') out += '\r'
      else if (e === 't') out += '\t'
      else if (e === 'u') {
        const hex = text.slice(i, i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape')
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else fail('bad escape')
      start = i
    }
  }

  const value = (depth: number): Value => {
    if (depth > MAX_DEPTH) fail('nesting too deep')
    skip()
    const c = text[i]
    if (c === '{') {
      i++
      const obj: Obj = Object.create(null)
      skip()
      if (text[i] === '}') {
        i++
        return obj
      }
      for (;;) {
        skip()
        if (text[i] !== '"') fail('expected a key')
        const key = string()
        skip()
        if (text[i] !== ':') fail('expected a colon')
        i++
        obj[key] = value(depth + 1)
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return obj
        }
        fail('expected a comma or a closing brace')
      }
    }
    if (c === '[') {
      i++
      const arr: Value[] = []
      skip()
      if (text[i] === ']') {
        i++
        return arr
      }
      for (;;) {
        arr.push(value(depth + 1))
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return arr
        }
        fail('expected a comma or a closing bracket')
      }
    }
    if (c === '"') return string()
    if (c === 't') return literal('true', true)
    if (c === 'f') return literal('false', false)
    if (c === 'n') return literal('null', null)
    if (c === '-' || (c >= '0' && c <= '9')) return number()
    return fail('unexpected token')
  }

  const out = value(0)
  skip()
  if (i !== n) fail('trailing data')
  return out
}
