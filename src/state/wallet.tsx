import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { connectWallet, type WalletSession } from '../wallet/mwa'

interface WalletApi {
  session: WalletSession | null
  connect: () => Promise<WalletSession>
  setSession: (s: WalletSession | null) => void
}

const Ctx = createContext<WalletApi | null>(null)

export function WalletStateProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null)
  const connect = useCallback(async () => {
    const s = await connectWallet()
    setSession(s)
    return s
  }, [])
  const value = useMemo(() => ({ session, connect, setSession }), [session, connect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWalletState(): WalletApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('WalletStateProvider missing')
  return v
}
