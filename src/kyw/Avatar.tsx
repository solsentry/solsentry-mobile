import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import React, { useMemo } from 'react'
import { Image, StyleSheet, View } from 'react-native'

import { useTheme } from '../ui/theme'

const SIZE = 36
const N = 5

/** 5×5 mirrored pattern from the address hash: level 0 to 4 per cell, the same on every phone. */
export function avatarCells(address: string): number[] {
  const h = sha256(utf8ToBytes(address))
  const cells: number[] = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const col = c < 3 ? c : N - 1 - c
      const byte = h[r * 3 + col]
      cells.push(byte % 3 === 0 ? 0 : 1 + (byte >> 6))
    }
  }
  return cells
}

/** Round picture of the wallet, drawn from its address in the day-grid colors; the app icon with no wallet. */
export function Avatar({ address, ring }: { address: string | null; ring: boolean }) {
  const t = useTheme()
  const cells = useMemo(() => (address ? avatarCells(address) : null), [address])
  const frame = [styles.frame, { borderColor: ring ? t.action : t.border2, backgroundColor: t.levels[0] }]
  if (!cells) return <Image source={require('@/assets/images/icon.png')} style={frame} />
  return (
    <View style={frame}>
      <View style={styles.grid}>
        {cells.map((level, i) => (
          <View key={i} style={[styles.cell, { backgroundColor: t.levels[level] }]} />
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
