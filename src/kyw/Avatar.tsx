import React, { useMemo } from 'react'
import { Image, StyleSheet, View } from 'react-native'

import { useTheme } from '../ui/theme'
import { avatarCells, N } from './identicon'

const SIZE = 36

/** Solana's purple-to-green, darkest to brightest; cell 0 stays the panel color. */
const PALETTE = ['#9945FF', '#6E6BEA', '#3FB8C9', '#14F195']

/** Round pixel picture of the wallet, drawn from its address in Solana colors; the app icon with no wallet. */
export function Avatar({ address, ring }: { address: string | null; ring: boolean }) {
  const t = useTheme()
  const cells = useMemo(() => (address ? avatarCells(address) : null), [address])
  const frame = [styles.frame, { borderColor: ring ? t.action : t.border2, backgroundColor: t.levels[0] }]
  if (!cells) return <Image source={require('@/assets/images/icon.png')} style={frame} />
  return (
    <View style={frame}>
      <View style={styles.grid}>
        {cells.map((level, i) => (
          <View key={i} style={[styles.cell, { backgroundColor: level === 0 ? t.levels[0] : PALETTE[level - 1] }]} />
        ))}
      </View>
    </View>
  )
}

const CELL = (SIZE - 2) / N

const styles = StyleSheet.create({
  frame: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1, overflow: 'hidden' },
  grid: { width: CELL * N, height: CELL * N, flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: CELL, height: CELL },
})
