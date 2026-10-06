import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { connectWallet, type WalletSession } from '../wallet/mwa'

interface WalletApi {
  session: WalletSession | null
  connect: () => Promise<WalletSession>
  setSession: (s: WalletSession | null) => void
  /** The wallet rejected the stored auth token: keep the address, ask for a fresh authorization next time. */
  forgetToken: () => void
}

const Ctx = createContext<WalletApi | null>(null)

export function WalletStateProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null)
  const forgetToken = useCallback(() => setSession((s) => (s ? { ...s, authToken: '' } : s)), [])
  const connect = useCallback(async () => {
    const s = await connectWallet(session?.authToken, { onTokenRejected: forgetToken })
    setSession(s)
    return s
  }, [session?.authToken, forgetToken])
  const value = useMemo(() => ({ session, connect, setSession, forgetToken }), [session, connect, forgetToken])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWalletState(): WalletApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('WalletStateProvider missing')
  return v
}
