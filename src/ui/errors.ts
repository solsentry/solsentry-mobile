// One place that turns a thrown error into what the user reads. Raw Java/MWA text never becomes
// the main line: it goes to `detail`, shown collapsed under the human sentence.
import { STALE_VERDICT_MESSAGE } from '../wallet/mwa-math'

export type WalletAction = 'send' | 'connect' | 'sender' | 'disconnect'

export interface UserError {
  message: string
  /** Technical text for a collapsed "Details" line; absent when the message says it all. */
  detail?: string
  /** The user cancelled or declined in the wallet. */
  cancelled?: boolean
}

export const CANCELLED_SEND = 'Cancelled in your wallet. Nothing was sent.'
export const CANCELLED_CONNECT = 'Cancelled in your wallet. Not connected.'

/** Our own errors that are already written for the user: shown as they are. */
const HUMAN = new Set([STALE_VERDICT_MESSAGE, 'The wallet returned no account.', 'The wallet returned no signature.'])

// MWA protocol codes (SolanaMobileWalletAdapterProtocolErrorCode).
const AUTHORIZATION_FAILED = -1
const INVALID_PAYLOADS = -2
const NOT_SIGNED = -3
const NOT_SUBMITTED = -4

const CANCEL_CODES = new Set<unknown>([
  'ERROR_ASSOCIATION_CANCELLED',
  'ERROR_SESSION_CLOSED',
  AUTHORIZATION_FAILED,
  NOT_SIGNED,
])
const CANCEL_TEXT = /CancellationException|cancell?ed by (the )?user|\bdeclined?\b|\brejected\b|user cancell?ed/i

function parts(e: unknown): { code: unknown; message: string } {
  if (e && typeof e === 'object') {
    const x = e as { code?: unknown; message?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } | null }
    // Inside a transact callback the RN module has not yet unwrapped the MWA code.
    const code =
      x.code === 'JSON_RPC_ERROR' && x.userInfo?.jsonRpcErrorCode != null ? x.userInfo.jsonRpcErrorCode : x.code
    return { code, message: typeof x.message === 'string' ? x.message : String(e) }
  }
  return { code: undefined, message: String(e ?? 'unknown error') }
}

function technical(code: unknown, message: string): string {
  return code === undefined || code === null || message.includes(String(code)) ? message : `${String(code)}: ${message}`
}

const FALLBACK: Record<WalletAction, string> = {
  send: 'The send did not complete. Check your wallet activity before trying again.',
  connect: 'Could not connect to your wallet. Try again.',
  sender: 'The source-of-funds check could not run. Try again.',
  disconnect: 'The wallet did not confirm the disconnect. This app has forgotten the wallet anyway.',
}

/** Map any wallet/send/check error to a short sentence plus the technical detail. */
export function describeError(e: unknown, action: WalletAction): UserError {
  const { code, message } = parts(e)
  const detail = technical(code, message)

  if (HUMAN.has(message)) return { message }

  if (CANCEL_CODES.has(code) || CANCEL_TEXT.test(message)) {
    if (action === 'send') return { message: CANCELLED_SEND, detail, cancelled: true }
    if (action === 'connect') return { message: CANCELLED_CONNECT, detail, cancelled: true }
    return { message: 'Cancelled in your wallet.', detail, cancelled: true }
  }
  if (code === 'ERROR_WALLET_NOT_FOUND') {
    return { message: 'No wallet app that supports Mobile Wallet Adapter was found on this phone.', detail }
  }
  if (code === 'ERROR_SESSION_TIMEOUT' || /timed out/i.test(message)) {
    return { message: 'The wallet did not answer in time. Try again.', detail }
  }
  if (action === 'send' && code === NOT_SUBMITTED) {
    return {
      message:
        'The wallet signed but could not submit the transaction. Check your wallet activity before trying again.',
      detail,
    }
  }
  if (action === 'send' && code === INVALID_PAYLOADS) {
    return { message: 'The wallet refused the transaction as invalid. Nothing was sent.', detail }
  }
  if (/network request failed|failed to fetch|blockhash/i.test(message)) {
    return { message: 'Could not reach the Solana network. Check your connection and try again.', detail }
  }
  return { message: FALLBACK[action], detail }
}
