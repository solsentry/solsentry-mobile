import { PublicKey, SystemProgram } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { parseScanned, parseSolanaPayUrl, unsupportedReason, type TransferRequest } from '../src/pay/solana-pay'
import { buildSolTransferInstructions, MEMO_PROGRAM_ID } from '../src/pay/transfer'
import { parseSolToLamports } from '../src/wallet/mwa-math'

const R = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN'
const REF1 = '82ZJ7nbGpixjeDCmEhUcmwXYfvurzAgGdtSMuHnUgyny'
const REF2 = '11111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function transfer(url: string): TransferRequest {
  const r = parseSolanaPayUrl(url)
  if (!r.ok) throw new Error(r.error)
  if (r.request.kind !== 'transfer') throw new Error('not a transfer')
  return r.request
}
const err = (url: string) => {
  const r = parseSolanaPayUrl(url)
  return r.ok ? null : r.error
}

describe('Solana Pay transfer requests (spec examples)', () => {
  it('parses recipient, amount, label, message, memo', () => {
    const r = transfer(`solana:${R}?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345`)
    expect(r).toMatchObject({ recipient: R, amount: '1', splToken: null, label: 'Michael', message: 'Thanks for all the fish', memo: 'OrderId12345' })
    expect(unsupportedReason(r)).toBeNull()
  })

  it('amount goes through parseSolToLamports exactly (no floating point)', () => {
    expect(parseSolToLamports(transfer(`solana:${R}?amount=0.000000001`).amount!)).toBe(1n)
    expect(parseSolToLamports(transfer(`solana:${R}?amount=1.01`).amount!)).toBe(1_010_000_000n)
    expect(parseSolToLamports(transfer(`solana:${R}?amount=0.1`).amount!)).toBe(100_000_000n)
  })

  it('rejects invalid amounts: exponent, sign, no leading zero, > 9 decimals for SOL', () => {
    for (const a of ['1e3', '-1', '.5', '1.', 'abc', '0x10', '1,5']) expect(err(`solana:${R}?amount=${a}`)).toMatch(/not a valid number/)
    expect(err(`solana:${R}?amount=0.0000000001`)).toMatch(/more than 9 decimals/)
  })

  it('missing amount -> null (the user types it)', () => {
    expect(transfer(`solana:${R}`).amount).toBeNull()
    expect(transfer(`solana:${R}?label=Shop`).amount).toBeNull()
  })

  it('zero amount parses (spec allows it) but cannot be sent', () => {
    const r = transfer(`solana:${R}?amount=0`)
    expect(r.amount).toBe('0')
    expect(() => parseSolToLamports(r.amount!)).toThrow()
  })

  it('keeps multiple references in order', () => {
    expect(transfer(`solana:${R}?amount=1&reference=${REF1}&reference=${REF2}`).references).toEqual([REF1, REF2])
  })

  it('invalid recipient / reference / spl-token are rejected', () => {
    expect(err('solana:0xffff')).toMatch(/invalid recipient/)
    expect(err(`solana:${R.slice(0, -1)}`)).toMatch(/invalid recipient/)
    expect(err(`solana:${R}?amount=1&reference=0xffff`)).toMatch(/invalid reference/)
    expect(err(`solana:${R}?amount=1&spl-token=0xffff`)).toMatch(/invalid spl-token/)
    expect(err('solana:')).toMatch(/no recipient/)
    expect(err('bitcoin:abc')).toMatch(/must start with/)
    expect(err(`solana:${R}?label=%E0%A4%A`)).toMatch(/malformed/)
  })

  it('url-encoded UTF-8 label and message are decoded', () => {
    const r = transfer(`solana:${R}?label=Caf%C3%A9%20%26%20Co&message=Pedido%20%2342%20%E2%9C%93`)
    expect(r.label).toBe('Café & Co')
    expect(r.message).toBe('Pedido #42 ✓')
  })

  it('spl-token request parses but is marked unsupported (recipient still checked by the caller)', () => {
    const r = transfer(`solana:${R}?amount=0.01&spl-token=${USDC}`)
    expect(r.splToken).toBe(USDC)
    expect(r.recipient).toBe(R)
    expect(unsupportedReason(r)).toBe('SPL token payments not supported yet. This app only sends SOL; nothing will be sent.')
    // Token amounts may exceed 9 decimals; that is the mint's business, not SOL's.
    expect(transfer(`solana:${R}?amount=0.0000000001&spl-token=${USDC}`).amount).toBe('0.0000000001')
  })
})

describe('Solana Pay transaction requests', () => {
  it('plain and URL-encoded https links are transaction requests, marked unsupported', () => {
    for (const url of ['solana:https://example.com/solana-pay', 'solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345']) {
      const r = parseSolanaPayUrl(url)
      expect(r.ok).toBe(true)
      if (!r.ok || r.request.kind !== 'transaction') throw new Error('expected transaction request')
      expect(r.request.link.startsWith('https://example.com/solana-pay')).toBe(true)
      expect(unsupportedReason(r.request)).toMatch(/not supported/)
    }
    const enc = parseSolanaPayUrl('solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345&label=Shop')
    expect(enc.ok && enc.request.kind === 'transaction' && enc.request.link).toBe('https://example.com/solana-pay?order=12345&label=Shop')
  })

  it('non-HTTPS links are rejected', () => {
    expect(err('solana:http%3A%2F%2Fexample.com')).toMatch(/not an HTTPS URL/)
  })
})

describe('scanned QR content', () => {
  it('bare address, Solana Pay link, or an error', () => {
    expect(parseScanned(` ${R} `)).toEqual({ ok: true, request: { kind: 'address', address: R } })
    const pay = parseScanned(`SOLANA:${R}?amount=2`)
    expect(pay.ok && pay.request.kind === 'pay' && pay.request.request.kind === 'transfer' && pay.request.request.amount).toBe('2')
    expect(parseScanned('https://evil.example')).toMatchObject({ ok: false })
  })
})

describe('Solana Pay transfer instructions', () => {
  const from = new PublicKey(REF2)
  const to = new PublicKey(R)
  it('memo first, then the transfer with references as read-only non-signers', () => {
    const ix = buildSolTransferInstructions(from, to, 5n, { memo: 'OrderId12345', references: [REF1] })
    expect(ix).toHaveLength(2)
    expect(ix[0].programId.equals(MEMO_PROGRAM_ID)).toBe(true)
    expect(Buffer.from(ix[0].data).toString('utf8')).toBe('OrderId12345')
    expect(ix[1].programId.equals(SystemProgram.programId)).toBe(true)
    expect(ix[1].keys[1].pubkey.equals(to)).toBe(true)
    expect(ix[1].keys[2]).toMatchObject({ isSigner: false, isWritable: false })
    expect(ix[1].keys[2].pubkey.toBase58()).toBe(REF1)
  })
  it('plain transfer without extras is unchanged', () => {
    const ix = buildSolTransferInstructions(from, to, 5n)
    expect(ix).toHaveLength(1)
    expect(ix[0].keys).toHaveLength(2)
  })
})
