import React, { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { theme } from '../ui/theme'
import { VERDICT_LABEL } from './copy'
import type { TaskRecord, Verdict } from './types'

const ROWS = 7
const CELL = 18
const GAP = 4

export const VERDICT_COLOR: Record<Verdict, string> = {
  accepted: theme.allow,
  diverged: theme.warn,
  unknown: '#6B6456',
}

/** Contribution-style grid: one square per task, oldest at the top left, filled column by column. */
export function Grid({
  records,
  selectedId,
  onSelect,
}: {
  records: TaskRecord[]
  selectedId: string | null
  onSelect: (record: TaskRecord) => void
}) {
  const [width, setWidth] = useState(0)
  const columns = width > 0 ? Math.max(1, Math.floor((width + GAP) / (CELL + GAP))) : 0
  const shown = records.slice(-columns * ROWS)
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.grid}>
      {Array.from({ length: columns }, (_, c) => (
        <View key={c} style={styles.column}>
          {Array.from({ length: ROWS }, (_, r) => {
            const record = shown[c * ROWS + r]
            if (!record) return <View key={r} style={styles.cell} />
            return (
              <Pressable
                key={r}
                accessibilityRole="button"
                accessibilityLabel={`${VERDICT_LABEL[record.verdict]} ${record.short}`}
                hitSlop={2}
                onPress={() => onSelect(record)}
                style={[
                  styles.cell,
                  { backgroundColor: VERDICT_COLOR[record.verdict], borderColor: VERDICT_COLOR[record.verdict] },
                  record.id === selectedId && styles.selected,
                ]}
              />
            )
          })}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: GAP, minHeight: ROWS * (CELL + GAP) - GAP },
  column: { gap: GAP },
  cell: {
    width: CELL,
    height: CELL,
    borderRadius: 4,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  selected: { borderColor: theme.text, borderWidth: 2 },
})
