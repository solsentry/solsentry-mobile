// Motion of the home mockup: blocks rise in on open, the fan turns while validating, a number that
// grows flashes orange. Reanimated CSS animations, so nothing here runs on the JS thread per frame.
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons'
import React, { useEffect, useRef } from 'react'
import type { StyleProp, TextStyle, ViewStyle } from 'react-native'
import Animated, { cubicBezier, interpolateColor, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'

const EASE_OUT = cubicBezier(0.2, 0.9, 0.2, 1)

const FADE_UP = {
  from: { opacity: 0, transform: [{ translateY: 10 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] },
}

/** A block that rises in when the screen opens; `order` staggers the blocks 60 ms apart. */
export function FadeUp({ order, style, children }: { order: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const reduced = useReducedMotion()
  if (reduced) return <Animated.View style={style}>{children}</Animated.View>
  return (
    <Animated.View
      style={[
        style,
        {
          animationName: FADE_UP,
          animationDuration: '550ms',
          animationDelay: `${40 + order * 60}ms`,
          animationTimingFunction: EASE_OUT,
          animationFillMode: 'both',
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

const SPIN = { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } }

/** The fan of the status button: turns while validating, stops where it is when paused. */
export function Fan({ running, color, size = 18 }: { running: boolean; color: string; size?: number }) {
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={
        reduced
          ? undefined
          : {
              animationName: SPIN,
              animationDuration: '1200ms',
              animationIterationCount: 'infinite',
              animationTimingFunction: 'linear',
              animationPlayState: running ? 'running' : 'paused',
            }
      }
    >
      <MaterialCommunityIcons name="fan" size={size} color={color} />
    </Animated.View>
  )
}

/** Text that flashes `flash` and fades back to `color` each time `value` grows once `armed` (data loaded). */
export function FlashText({
  value,
  armed,
  color,
  flash,
  style,
  children,
}: {
  value: number
  armed: boolean
  color: string
  flash: string
  style?: StyleProp<TextStyle>
  children: React.ReactNode
}) {
  const progress = useSharedValue(0)
  const last = useRef(value)
  useEffect(() => {
    if (armed && value > last.current) {
      progress.value = 1
      progress.value = withTiming(0, { duration: 1200 })
    }
    last.current = value
  }, [value, armed, progress])
  const animated = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 1], [color, flash]) }), [color, flash])
  return <Animated.Text style={[style, animated]}>{children}</Animated.Text>
}
