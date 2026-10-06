import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { HistoryProvider } from '@/src/state/history'
import { WalletStateProvider } from '@/src/state/wallet'

export default function RootLayout() {
  return (
    <HistoryProvider>
      <WalletStateProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="dark" />
      </WalletStateProvider>
    </HistoryProvider>
  )
}
