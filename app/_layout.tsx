import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect } from 'react'

import { useKyw } from '@/src/kyw/useKyw'
import { ThemeContext, dark, light } from '@/src/ui/theme'

export default function RootLayout() {
  const { settings } = useKyw()
  const t = settings.theme === 'light' ? light : dark
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg).catch(() => {})
  }, [t])
  return (
    <ThemeContext.Provider value={t}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
      <StatusBar style={t.name === 'light' ? 'dark' : 'light'} />
    </ThemeContext.Provider>
  )
}
