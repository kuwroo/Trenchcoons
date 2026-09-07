// Spatial hash for world-fixed scatter / grass lattices.
//
// Placement must be a pure function of (cellX, cellZ, channel, worldSeed).
// Streaming bands only decide WHICH cells are currently drawn — never WHAT
// a cell contains. Folding `worldSeed` in is what makes `?seed=` change the
// vegetation map along with the heightfield.
//
// The default URL seed (`trenchcoons`) XORs to zero so existing screenshot
// gates stay bit-stable; any other seed rotates the lattice.

import { hashSeed } from './rng'

/** u32 for the URL default seed — XOR identity for placement hashes. */
const DEFAULT_WORLD_SEED = hashSeed('trenchcoons')

/** Deterministic [0,1) hash of an integer lattice cell. */
export function spatialHash(
  ix: number, iz: number, channel: number, worldSeed = 0,
): number {
  // Default seed → 0 keeps the pre-seed-fold channel mix bit-identical.
  const seedMix = ((worldSeed >>> 0) ^ DEFAULT_WORLD_SEED) >>> 0
  let h = (
    Math.imul(ix, 0x27d4eb2d) ^
    Math.imul(iz, 0x165667b1) ^
    Math.imul(channel, 0x9e3779b1) ^
    seedMix
  ) >>> 0
  h = Math.imul(h ^ (h >>> 15), h | 1) >>> 0
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296
}
