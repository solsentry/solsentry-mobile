import { describe, expect, it } from 'vitest'
import { CANCELLED_CONNECT, CANCELLED_SEND, describeError, type WalletAction } from '../src/ui/errors'
import { STALE_VERDICT_MESSAGE } from '../src/wallet/mwa-math'

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra)

describe('describeError', () => {
  const table: [string, unknown, WalletAction, string, boolean][] = [
    // [case, input, action, expected message, has detail]
    ['Seeker cancel (seen on device)', err('java.util.concurrent.CancellationException'), 'send', CANCELLED_SEND, true],
    ['association cancelled', err('x', { code: 'ERROR_ASSOCIATION_CANCELLED' }), 'send', CANCELLED_SEND, true],
    ['session closed', err('closed', { code: 'ERROR_SESSION_CLOSED' }), 'send', CANCELLED_SEND, true],
    ['-1 wrapped, after decline', err('authorization request failed', { code: -1 }), 'send', CANCELLED_SEND, true],
    [
      '-1 raw RN shape',
      err('authorization request failed', { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: -1 } }),
      'send',
      CANCELLED_SEND,
      true,
    ],
    ['-3 not signed', err('transaction not signed', { code: -3 }), 'send', CANCELLED_SEND, true],
    ['"declined" text', err('User declined the request'), 'send', CANCELLED_SEND, true],
    ['"rejected" text', err('Request rejected'), 'send', CANCELLED_SEND, true],
    [
      'local association cancelled by user',
      err('Session not established: Local association cancelled by user'),
      'connect',
      CANCELLED_CONNECT,
      true,
    ],
    [
      'cancel on sender check',
      err('java.util.concurrent.CancellationException'),
      'sender',
      'Cancelled in your wallet.',
      true,
    ],
    [
      'no wallet installed',
      err('Found no installed wallet', { code: 'ERROR_WALLET_NOT_FOUND' }),
      'connect',
      'No wallet app that supports Mobile Wallet Adapter was found on this phone.',
      true,
    ],
    ['timeout', err('Timed out waiting for response'), 'send', 'The wallet did not answer in time. Try again.', true],
    [
      '-4 not submitted',
      err('not submitted', { code: -4 }),
      'send',
      'The wallet signed but could not submit the transaction. Check your wallet activity before trying again.',
      true,
    ],
    [
      '-2 invalid payload',
      err('invalid', { code: -2 }),
      'send',
      'The wallet refused the transaction as invalid. Nothing was sent.',
      true,
    ],
    [
      'network down',
      err('failed to get recent blockhash: TypeError: Network request failed'),
      'send',
      'Could not reach the Solana network. Check your connection and try again.',
      true,
    ],
    ['stale verdict (already human)', err(STALE_VERDICT_MESSAGE), 'send', STALE_VERDICT_MESSAGE, false],
    [
      'unknown on send',
      err('java.lang.IllegalStateException: boom'),
      'send',
      'The send did not complete. Check your wallet activity before trying again.',
      true,
    ],
    ['unknown on connect', err('weird'), 'connect', 'Could not connect to your wallet. Try again.', true],
    ['unknown on sender', err('weird'), 'sender', 'The source-of-funds check could not run. Try again.', true],
    [
      'non-Error value',
      'boom',
      'send',
      'The send did not complete. Check your wallet activity before trying again.',
      true,
    ],
  ]

  it.each(table)('%s', (_name, input, action, message, hasDetail) => {
    const out = describeError(input, action)
    expect(out.message).toBe(message)
    expect(!!out.detail).toBe(hasDetail)
    // Raw Java/MWA text never becomes the main line.
    expect(out.message).not.toMatch(/java\.|Exception|JSON_RPC/)
  })

  it('keeps the raw text in the detail line, with the MWA code', () => {
    expect(describeError(err('java.util.concurrent.CancellationException'), 'send').detail).toBe(
      'java.util.concurrent.CancellationException',
    )
    expect(describeError(err('authorization request failed', { code: -1 }), 'send').detail).toBe(
      '-1: authorization request failed',
    )
  })
})
