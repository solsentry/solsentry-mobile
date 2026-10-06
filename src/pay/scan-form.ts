// How a scanned Solana Pay request and later hand edits change the send form.
//
// Rules (device bug: a USDC QR with amount=1 put "1" in the SOL field, and after the user typed
// another recipient Send would have paid 1 SOL):
//   1. Only a SOL transfer request writes the SOL amount field. An SPL-token request or a
//      transaction request clears it; their amount lives only in the request card.
//   2. Editing the recipient by hand drops the request card. If that request was SPL, the amount
//      field is cleared too.
//   3. An amount set by a QR belongs to that QR's recipient: editing the recipient clears it,
//      unless the user typed the amount themselves after the scan.
import { parseSolToLamports } from '../wallet/mwa-math'
import { unsupportedReason, type SolanaPayRequest } from './solana-pay'

export interface PayForm {
  address: string
  /** Text of the "Amount (SOL)" field. */
  amount: string
  /** The amount field holds what a QR wrote (not something the user typed). */
  amountFromQr: boolean
  /** Solana Pay request card; null when the form was filled by hand. */
  payRequest: SolanaPayRequest | null
}

export const EMPTY_FORM: PayForm = { address: '', amount: '', amountFromQr: false, payRequest: null }

/** A scanned / opened Solana Pay request fills the form. */
export function formAfterPayRequest(f: PayForm, req: SolanaPayRequest): PayForm {
  if (req.kind === 'transaction') return { ...f, payRequest: req, amount: '', amountFromQr: true }
  if (req.splToken) return { ...f, payRequest: req, address: req.recipient, amount: '', amountFromQr: true }
  return { ...f, payRequest: req, address: req.recipient, amount: req.amount ?? '', amountFromQr: true }
}

/** The recipient changed by hand (typed, pasted, or picked elsewhere). */
export function formAfterRecipientEdit(f: PayForm, address: string): PayForm {
  const wasSpl = f.payRequest?.kind === 'transfer' && !!f.payRequest.splToken
  const clearAmount = wasSpl || f.amountFromQr
  return {
    address,
    payRequest: null,
    amount: clearAmount ? '' : f.amount,
    amountFromQr: false,
  }
}

/** The user typed the amount: it is theirs now and survives a recipient edit. */
export function formAfterAmountEdit(f: PayForm, amount: string): PayForm {
  return { ...f, amount, amountFromQr: false }
}

/** The form holds a SOL amount that can be sent (no unsupported request, a valid amount). */
export function formCanSend(f: PayForm): boolean {
  if (f.payRequest && unsupportedReason(f.payRequest)) return false
  try {
    parseSolToLamports(f.amount)
    return true
  } catch {
    return false
  }
}
