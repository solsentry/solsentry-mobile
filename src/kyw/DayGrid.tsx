import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { fonts, theme } from '../ui/theme'
import { TEXT } from './copy'
import { dayStreak, lastDays } from './history'

const LEVELS = ['#1C1F1C', '#4A2C14', '#87491B', '#C96A24', '#F28A35'] as const

/** 0 for an empty day, then quartiles of the busiest day in view. */
export function dayLevel(matched: number, max: number): number {
  if (matched <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((matched / max) * 4)))
}

const label = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Activity of the last 28 days: one square per day, darker to brighter by matched results. */
export function DayGrid({ days, now }: { days: Record<string, number>; now: number }) {
  const list = lastDays(days, now)
  const [picked, setPicked] = useState<string | null>(null)
  const max = Math.max(...list.map((d) => d.matched))
  const sel = list.find((d) => d.key === picked) ?? list[list.length - 1]
  const streak = dayStreak(days, now)
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>{TEXT.daysTitle}</Text>
        <Text style={styles.eyebrow}>
          {sel === list[list.length - 1] ? TEXT.today : label(sel.date)} · {sel.matched.toLocaleString('en-US')}
        </Text>
      </View>
      {[0, 7, 14, 21].map((from) => list.slice(from, from + 7)).map((row, i) => (
        <View key={i} style={styles.grid}>
          {row.map((d) => (
            <Pressable
              key={d.key}
              accessibilityRole="button"
              accessibilityLabel={`${label(d.date)}: ${d.matched} ${TEXT.daysUnit}`}
              onPress={() => setPicked(d.key)}
              style={[styles.cell, { backgroundColor: LEVELS[dayLevel(d.matched, max)] }, d.key === sel.key && styles.cellSel]}
            />
          ))}
        </View>
      ))}
      {streak > 1 && <Text style={styles.muted}>{TEXT.streak(streak)}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  head: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  eyebrow: { color: theme.muted, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', fontFamily: fonts.mono },
  grid: { flexDirection: 'row', gap: 6 },
  cell: { flex: 1, aspectRatio: 1, borderRadius: 8 },
  cellSel: { borderWidth: 2, borderColor: theme.text },
  muted: { color: theme.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 4 },
})
