import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { HistoryProvider } from '@/src/state/history'
import { WalletStateProvider } from '@/src/state/wallet'
import { theme } from '@/src/ui/theme'

export default function RootLayout() {
  return (
    <HistoryProvider>
      <WalletStateProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
        <StatusBar style="light" />
      </WalletStateProvider>
    </HistoryProvider>
  )
}
