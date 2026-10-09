import { isSolanaPayUrl } from '@/src/pay/solana-pay'

/**
 * A `solana:` link (only delivered when the opt-in intent filter is built in, see
 * app.config.js) is not an app route. Rewrite it to the Check & Send screen, which parses it,
 * fills the form and runs the recipient check. Everything else passes through unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (isSolanaPayUrl(path)) return `/?pay=${encodeURIComponent(path)}&t=${Date.now()}`
  } catch {
    // fall through: never crash on an incoming link
  }
  return path
}
