import { router } from 'expo-router'

/** Back, or Home when the screen was opened by a link with nothing under it (back alone does nothing then). */
export function backOrHome(): void {
  if (router.canGoBack()) router.back()
  else router.replace('/')
}
