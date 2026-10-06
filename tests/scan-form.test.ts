import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  formAfterAmountEdit,
  formAfterPayRequest,
  formAfterRecipientEdit,
  formCanSend,
} from '../src/pay/scan-form'
import { parseSolanaPayUrl, type SolanaPayRequest } from '../src/pay/solana-pay'

const MERCHANT = '4kxscuteRLQdNiTXA33YYsvywAPNA6DQTifswxjL5pH1'
const OTHER = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function parse(url: string): SolanaPayRequest {
  const r = parseSolanaPayUrl(url)
  if (!r.ok) throw new Error(r.error)
  return r.request
}

describe('scanned Solana Pay request vs the SOL amount field', () => {
  it('SPL request never writes the SOL amount; editing the recipient keeps it empty and Send disabled', () => {
    // The user had typed something before scanning: the SPL scan clears it too.
    const before = formAfterAmountEdit(EMPTY_FORM, '0.2')
    const scanned = formAfterPayRequest(before, parse(`solana:${MERCHANT}?spl-token=${USDC}&amount=1`))
    expect(scanned.amount).toBe('')
    expect(scanned.address).toBe(MERCHANT)
    expect(formCanSend(scanned)).toBe(false)

    const edited = formAfterRecipientEdit(scanned, OTHER)
    expect(edited.payRequest).toBeNull()
    expect(edited.amount).toBe('')
    expect(formCanSend(edited)).toBe(false)
  })

  it('SOL request prefills the amount; editing the recipient clears the QR amount and the card', () => {
    const scanned = formAfterPayRequest(EMPTY_FORM, parse(`solana:${MERCHANT}?amount=1`))
    expect(scanned.amount).toBe('1')
    expect(formCanSend(scanned)).toBe(true)
    const edited = formAfterRecipientEdit(scanned, OTHER)
    expect(edited).toEqual({ address: OTHER, amount: '', amountFromQr: false, payRequest: null })
    expect(formCanSend(edited)).toBe(false)
  })

  it('an amount the user typed after the scan survives a recipient edit', () => {
    const scanned = formAfterPayRequest(EMPTY_FORM, parse(`solana:${MERCHANT}?amount=1`))
    const typed = formAfterAmountEdit(scanned, '0.3')
    const edited = formAfterRecipientEdit(typed, OTHER)
    expect(edited.amount).toBe('0.3')
    expect(edited.payRequest).toBeNull()
    // ...and the next edit keeps it too (still the user's).
    expect(formAfterRecipientEdit(edited, MERCHANT).amount).toBe('0.3')
  })

  it('a hand-typed amount with no scan is kept when the recipient changes', () => {
    const f = formAfterRecipientEdit(formAfterAmountEdit(EMPTY_FORM, '0.05'), OTHER)
    expect(f.amount).toBe('0.05')
  })

  it('a transaction request never sets the amount', () => {
    const before = formAfterAmountEdit(formAfterRecipientEdit(EMPTY_FORM, OTHER), '0.4')
    const req = parse('solana:https%3A%2F%2Fmerchant.example%2Fpay%3Famount%3D1')
    expect(req.kind).toBe('transaction')
    const scanned = formAfterPayRequest(before, req)
    expect(scanned.amount).toBe('')
    expect(formCanSend(scanned)).toBe(false)
  })
})
