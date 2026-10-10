import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'

import { fonts, makeStyles, useTheme } from '../ui/theme'
import { TEXT } from './copy'
import { dayLevel, dayStreak, lastDays } from './history'

const label = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const FILL = { from: { height: '0%' }, to: { height: '100%' } } as const

/**
 * Activity of the last 28 days: one square per day, darker to brighter by matched results. While
 * validating, today's square fills from the bottom over and over, as in the mockup.
 */
export function DayGrid({ days, now, running }: { days: Record<string, number>; now: number; running: boolean }) {
  const t = useTheme()
  const styles = useStyles()
  const list = lastDays(days, now)
  const [picked, setPicked] = useState<string | null>(null)
  const max = Math.max(...list.map((d) => d.matched))
  const today = list[list.length - 1]
  const sel = list.find((d) => d.key === picked) ?? today
  const streak = dayStreak(days, now)
  const reduced = useReducedMotion()
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>{TEXT.daysTitle}</Text>
        <Text style={styles.selLabel}>
          {sel === today ? TEXT.today : label(sel.date)} · {sel.matched.toLocaleString('en-US')}
        </Text>
      </View>
      {[0, 7, 14, 21].map((from) => list.slice(from, from + 7)).map((row, i) => (
        <View key={i} style={styles.grid}>
          {row.map((d) => {
            const filling = running && !reduced && d.key === today.key
            return (
              <Pressable
                key={d.key}
                accessibilityRole="button"
                accessibilityLabel={`${label(d.date)}: ${d.matched} ${TEXT.daysUnit}`}
                onPress={() => setPicked(d.key)}
                style={[styles.cell, { backgroundColor: t.levels[filling ? 1 : dayLevel(d.matched, max)] }, d.key === sel.key && styles.cellSel]}
              >
                {filling && (
                  <Animated.View
                    style={[
                      styles.fill,
                      { animationName: FILL, animationDuration: '12s', animationIterationCount: 'infinite', animationTimingFunction: 'linear' },
                    ]}
                  />
                )}
              </Pressable>
            )
          })}
        </View>
      ))}
      {streak > 1 && <Text style={styles.muted}>{TEXT.streak(streak)}</Text>}
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 6 },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
    eyebrow: { color: t.muted, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', fontFamily: fonts.mono },
    selLabel: { color: t.muted, fontSize: 10.5, fontFamily: fonts.mono, textTransform: 'uppercase' },
    grid: { flexDirection: 'row', gap: 6 },
    cell: { flex: 1, aspectRatio: 1, borderRadius: 8, overflow: 'hidden', justifyContent: 'flex-end' },
    cellSel: { borderWidth: 2, borderColor: t.text },
    fill: { width: '100%', backgroundColor: t.action },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 4 },
  }),
)
