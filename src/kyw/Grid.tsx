import React, { useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'

import { useTheme, type Palette } from '../ui/theme'
import { VERDICT_LABEL } from './copy'
import type { TaskRecord, Verdict } from './types'

const COLUMNS = 25
const ROWS = 4
const GAP = 5

export const verdictColor = (t: Palette): Record<Verdict, string> => ({
  // The mockup's dots: orange for a matched result; a diverged one stands out in red.
  accepted: t.action,
  diverged: t.block,
  unknown: t.unknown,
})

const LANDED = {
  '0%': { transform: [{ scale: 1 }] },
  '40%': { transform: [{ scale: 1.8 }] },
  '100%': { transform: [{ scale: 1 }] },
}

/**
 * The last 100 tasks as dots, 25 to a row, oldest at the top left. A new task pops in at the end;
 * a tap on a dot shows that task below.
 */
export function Grid({
  records,
  loaded,
  selectedId,
  onSelect,
}: {
  records: TaskRecord[]
  /** The stored history has been read; before that the list is empty and nothing should pop. */
  loaded: boolean
  selectedId: string | null
  onSelect: (record: TaskRecord) => void
}) {
  const t = useTheme()
  const colors = verdictColor(t)
  const reduced = useReducedMotion()
  const [width, setWidth] = useState(0)
  const shown = records.slice(-COLUMNS * ROWS)
  // Only a task that arrives while the screen is open pops; the ones already there do not.
  const newest = shown[shown.length - 1]?.id ?? null
  const firstNewest = useRef<string | null | undefined>(undefined)
  if (loaded && firstNewest.current === undefined) firstNewest.current = newest
  const cell = width / COLUMNS
  const dot = Math.max(4, cell - GAP * (COLUMNS - 1) / COLUMNS)
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[styles.grid, { minHeight: width > 0 ? cell * ROWS : 0 }]}>
      {width > 0 &&
        Array.from({ length: COLUMNS * ROWS }, (_, i) => {
          const record = shown[i]
          const box = { width: cell, height: cell }
          if (!record) {
            return (
              <View key={`empty${i}`} style={[styles.box, box]}>
                <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: t.track }} />
              </View>
            )
          }
          const pop = !reduced && firstNewest.current !== undefined && record.id === newest && record.id !== firstNewest.current
          return (
            <Pressable
              key={record.id}
              accessibilityRole="button"
              accessibilityLabel={`${VERDICT_LABEL[record.verdict]} ${record.short}`}
              onPress={() => onSelect(record)}
              style={[styles.box, box]}
            >
              <Animated.View
                style={[
                  { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: colors[record.verdict] },
                  record.id === selectedId && { borderWidth: 1.5, borderColor: t.text },
                  pop && { animationName: LANDED, animationDuration: '900ms', animationTimingFunction: 'ease-out' },
                ]}
              />
            </Pressable>
          )
        })}
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  box: { alignItems: 'center', justifyContent: 'center' },
})
