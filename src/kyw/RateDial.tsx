import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier, useReducedMotion } from 'react-native-reanimated'

import { fonts, makeStyles, useTheme } from '../ui/theme'
import { pointsText, POINT_RULE } from './points'

const BARS = 37
const HEIGHT = 54
const MIN = POINT_RULE.base
const MAX = POINT_RULE.base + POINT_RULE.attested + POINT_RULE.genesis + POINT_RULE.independentRpc
/** Bar a rate points at: the scale runs from the base (bar 4) to the top rate (bar 32). */
const barOf = (rate: number) => 4 + Math.max(0, Math.min(1, (rate - MIN) / (MAX - MIN))) * 28
/** Labelled rates: base, attested, Genesis, Genesis with own RPC. */
const STOPS = [MIN, MIN + POINT_RULE.attested, MIN + POINT_RULE.attested + POINT_RULE.genesis, MAX]
  .map((r) => Math.round(r * 10) / 10)
  .map((rate) => ({ rate, bar: barOf(rate) }))

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

  const live = running && rate > 0
  const at = barOf(rate)
  const level = (rate - MIN) / (MAX - MIN)
  const amp = 29 + 15 * level
  const sig = 4.5 + 2 * level
  const step = width > 0 ? (width - 3) / (BARS - 1) : 0

  return (
    <View accessibilityRole="image" accessibilityLabel={`${pointsText(rate)} points per result`}>
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
        {width > 0 && (
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
            <Text key={x.rate} style={[s.stop, { left: x.bar * step + 1.5 - 18, color: x.rate === rate ? t.actionText : t.muted }]}>
              {pointsText(x.rate)}
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
    stop: { position: 'absolute', width: 36, textAlign: 'center', fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.9 },
  }),
)
