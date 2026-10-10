import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier, useReducedMotion } from 'react-native-reanimated'

import { fonts, makeStyles, useTheme } from '../ui/theme'
import { multiplierText, POINT_RULE } from './points'

const BARS = 37
const HEIGHT = 54
/** The rates a phone can have, left to right, and the bar each one points at. */
const STOPS = [
  POINT_RULE.base,
  POINT_RULE.independentRpc,
  POINT_RULE.genesis,
  POINT_RULE.genesis * POINT_RULE.independentRpc,
].map((rate, i) => ({ rate, bar: 4 + i * 9 }))

// Fixed per-bar height so the idle dial is not a flat line (same noise on every render).
const NOISE = Array.from({ length: BARS }, (_, i) => Math.abs(Math.sin((i + 2) * 12.9898) * 43758.5453) % 1)

const BAR_EASE = cubicBezier(0.3, 0.9, 0.3, 1)
const PTR_EASE = cubicBezier(0.34, 1.35, 0.5, 1)
const PULSE = { '0%': { transform: [{ scale: 1 }] }, '50%': { transform: [{ scale: 1.25 }] }, '100%': { transform: [{ scale: 1 }] } }

/**
 * Rate meter of the mockup: 37 bars with a pointer on the current rate. While validating, the bars
 * around the pointer rise and move a little each second; paused, the dial lies flat.
 */
export function RateDial({ rate, running }: { rate: number; running: boolean }) {
  const t = useTheme()
  const s = useStyles()
  const [width, setWidth] = useState(0)
  const [tick, setTick] = useState(0)
  // With reduced motion the dial still rises while validating, but holds still: no jitter, no pulse.
  const reduced = useReducedMotion()
  useEffect(() => {
    if (!running || reduced) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running, reduced])

  const stop = STOPS.find((x) => x.rate === rate)
  const live = running && stop !== undefined
  const at = stop?.bar ?? 0
  const amp = 22 + 7 * rate
  const sig = 3.5 + rate
  const step = width > 0 ? (width - 3) / (BARS - 1) : 0

  return (
    <View accessibilityRole="image" accessibilityLabel={`Rate ${multiplierText(rate)}`}>
      <View style={s.dial} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={s.bars}>
          {NOISE.map((noise, i) => {
            const g = Math.exp(-((i - at) ** 2) / (2 * sig * sig))
            const jitter = 0.8 + 0.2 * Math.abs(Math.sin(tick * 1.3 + i * 0.7))
            const base = 4 + noise * 5
            const hot = live && Math.abs(i - at) <= sig
            return (
              <Animated.View
                key={i}
                style={[
                  s.bar,
                  {
                    height: live ? base + amp * g * jitter : base,
                    backgroundColor: hot ? t.action : t.track,
                    opacity: hot ? 0.45 + 0.55 * g : 1,
                    transitionProperty: ['height', 'backgroundColor', 'opacity'],
                    transitionDuration: 550,
                    transitionTimingFunction: BAR_EASE,
                  },
                ]}
              />
            )
          })}
        </View>
        {stop && width > 0 && (
          <Animated.View
            style={[
              s.pointer,
              { left: at * step + 0.5, transitionProperty: 'left', transitionDuration: 750, transitionTimingFunction: PTR_EASE },
            ]}
          >
            <View style={s.needle} />
            <Animated.View
              style={[
                s.knob,
                live && !reduced && { animationName: PULSE, animationDuration: '1600ms', animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' },
              ]}
            />
          </Animated.View>
        )}
      </View>
      <View style={s.stops}>
        {width > 0 &&
          STOPS.map((x) => (
            <Text key={x.rate} style={[s.stop, { left: x.bar * step + 1.5 - 30, color: x.rate === rate ? t.actionText : t.muted }]}>
              {multiplierText(x.rate)}
            </Text>
          ))}
      </View>
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    dial: { height: 64, position: 'relative' },
    bars: { position: 'absolute', left: 0, right: 0, bottom: 0, height: HEIGHT, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    bar: { width: 3, borderRadius: 2 },
    pointer: { position: 'absolute', top: 0, bottom: 0, width: 2 },
    needle: { position: 'absolute', left: 0, top: 8, bottom: 0, width: 2, borderRadius: 1, backgroundColor: t.text },
    knob: { position: 'absolute', left: -4, top: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: t.action },
    stops: { height: 12, marginTop: 10, position: 'relative' },
    stop: { position: 'absolute', width: 60, textAlign: 'center', fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.9 },
  }),
)
