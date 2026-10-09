import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { theme } from '@/src/ui/theme'

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
      <StatusBar style="light" />
    </>
  )
}
