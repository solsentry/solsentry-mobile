// Brand palette: dark surfaces, amber for actions. Verdict colors are separate tokens:
// allow = teal, warn = amber, block = red (red is used for Block only).
export const theme = {
  bg: '#100E0A',
  surface: '#18150F',
  border: '#2A251C',
  text: '#F2EDE4',
  muted: '#B8B0A0',
  action: '#C17D0E',
  allow: '#2A7A7A',
  warn: '#C17D0E',
  block: '#FF4444',
  /** Text on amber and on red (white fails contrast on both). */
  ink: '#100E0A',
  /** Text on teal. Teal itself is only for borders, badges and large text on dark. */
  onAllow: '#FFFFFF',
  scrim: 'rgba(16,14,10,0.7)',
} as const
