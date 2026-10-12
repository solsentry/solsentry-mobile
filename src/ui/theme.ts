import { createContext, useContext, useMemo } from 'react'
import type { TextStyle } from 'react-native'

// Palettes of the home mockup (dark and light): near-black or paper surfaces, orange for actions.
// Verdict colors are separate tokens: allow = teal, warn = orange, block = red (red is used for Block only).
export const dark = {
  name: 'dark' as 'dark' | 'light',
  bg: '#090A09',
  surface: '#111311',
  /** Raised row inside a card. */
  surface2: '#171A17',
  border: 'rgba(255,255,255,0.09)',
  /** Stronger line: pills, sheet edge, outlined buttons. */
  border2: 'rgba(255,255,255,0.18)',
  text: '#F2F1EB',
  muted: '#8D928B',
  action: '#F28A35',
  /** Orange as text (the fill orange is too dim at small sizes on dark, too light on paper). */
  actionText: '#F5A05B',
  allow: '#5FD1B4',
  warn: '#F28A35',
  block: '#FF4444',
  /** Text on orange and on red (white fails contrast on both). */
  ink: '#17100A',
  /** Text on teal. */
  onAllow: '#17100A',
  /** Empty cell, switch track. */
  track: '#2A2E2A',
  /** A task SolSentry could not judge. */
  unknown: '#3A3F3A',
  scrim: 'rgba(0,0,0,0.6)',
  /** Day grid, empty to busiest. */
  levels: ['#1C1F1C', '#4A2C14', '#87491B', '#C96A24', '#F28A35'],
}

export type Palette = typeof dark

export const light: Palette = {
  name: 'light',
  bg: '#F4F1EA',
  surface: '#FFFFFF',
  surface2: '#FAF8F3',
  border: 'rgba(23,21,18,0.09)',
  border2: 'rgba(23,21,18,0.2)',
  text: '#171512',
  muted: '#67635B',
  action: '#E07A22',
  actionText: '#A9530F',
  allow: '#1F7A66',
  warn: '#E07A22',
  block: '#C62828',
  ink: '#17100A',
  onAllow: '#FFFFFF',
  track: '#DDD7CB',
  unknown: '#C9C2B5',
  scrim: 'rgba(23,21,18,0.42)',
  levels: ['#E7E2D8', '#F5CFA6', '#EFA764', '#E5852F', '#B95E12'],
}

/** Dark palette for screens that do not follow the theme switch (self-test). */
export const theme = dark

export const ThemeContext = createContext<Palette>(dark)

export const useTheme = (): Palette => useContext(ThemeContext)

/** Styles that follow the theme: built once per palette, then reused. */
export function makeStyles<T>(build: (t: Palette) => T): () => T {
  const cache = new Map<Palette, T>()
  return function useStyles() {
    const t = useTheme()
    return useMemo(() => {
      let s = cache.get(t)
      if (!s) {
        s = build(t)
        cache.set(t, s)
      }
      return s
    }, [t])
  }
}

// Typefaces embedded at build time by the expo-font plugin (see app.json). The mockup's mono is DM Mono,
// whose only zero is slashed and reads as "Ø"; Azeret Mono is the closest geometric mono with a plain zero.
export const fonts = {
  title: 'Manrope',
  body: 'Manrope',
  mono: 'AzeretMono',
} as const

/** Large numbers, in the mono face as in the mockup. */
export const figure: TextStyle = { fontFamily: fonts.mono }
