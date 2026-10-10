// Palette of the home mockup: near-black surfaces, orange for actions. Verdict colors are separate
// tokens: allow = teal, warn = orange, block = red (red is used for Block only).
export const theme = {
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
  /** Orange as text on dark (the fill orange is too dim at small sizes). */
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
  scrim: 'rgba(0,0,0,0.6)',
} as const

// Typefaces of the mockup, embedded at build time by the expo-font plugin (see app.json).
export const fonts = {
  title: 'Manrope',
  body: 'Manrope',
  mono: 'DMMono',
} as const
