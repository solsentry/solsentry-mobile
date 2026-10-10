import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

/** Cells per side of the wallet avatar. */
export const N = 5

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
