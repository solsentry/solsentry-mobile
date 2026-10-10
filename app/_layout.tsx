import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect } from 'react'
import { Appearance } from 'react-native'

import { useKyw } from '@/src/kyw/useKyw'
import { ThemeContext, dark, light } from '@/src/ui/theme'

// The splash stays up until the stored theme is read, so a light theme never starts with dark frames.
void SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const { settings, loaded } = useKyw()
  const t = settings.theme === 'light' ? light : dark
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg).catch(() => {})
    // Native dialogs (Alert) follow the app theme, not the phone's.
    Appearance.setColorScheme(t.name === 'light' ? 'light' : 'dark')
  }, [t])
  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync().catch(() => {})
  }, [loaded])
  return (
    <ThemeContext.Provider value={t}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
      <StatusBar style={t.name === 'light' ? 'dark' : 'light'} />
    </ThemeContext.Provider>
  )
}
