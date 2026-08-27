// Seeded scalar noise, shared by the heightfield and the climate fields.
//
// Lifted out of the old world/greybox.ts because two systems now need the SAME kind of
// field and neither may use Math.random (CLAUDE.md invariant). Everything here
// is a pure function of a seeded table, so a given seed always builds the same
// world — which is what makes the screenshot harness meaningful.

import type { Rng } from '../core/rng'

export type Noise2 = (x: number, y: number) => number

/**
 * Value noise on a wrapped 256x256 table with a smoothstep fade.
 *
 * Wrapped, so it is defined everywhere without a hash per lookup, and the
 * period (256 cells) is far larger than any feature size we ask of it.
 */
export function valueNoise(rng: Rng): Noise2 {
  const N = 256
  const table = new Float32Array(N * N)
  for (let i = 0; i < table.length; i++) table[i] = rng.float() * 2 - 1
  const at = (ix: number, iy: number): number =>
    table[(((iy % N) + N) % N) * N + (((ix % N) + N) % N)] ?? 0
  const fade = (t: number): number => t * t * (3 - 2 * t)
  return (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const tx = fade(x - xi)
    const ty = fade(y - yi)
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx
    return a * (1 - ty) + b * ty
  }
}

/**
 * Ridged variant. `1 - |n|` folded and squared: the folds become creases, which
 * is what gives a mountain mass its arêtes instead of a lumpy blob.
 *
 * ART_BIBLE §4 alpine asks for "sharp dark rock ridges punching through" and
 * says explicitly that they must be produced deliberately rather than as noise
 * artefacts. This is the deliberate part.
 */
export function ridged(noise: Noise2, x: number, y: number): number {
  const n = 1 - Math.abs(noise(x, y))
  return n * n
}

/** Smoothstep, clamped. The one easing this module uses. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-9)))
  return t * t * (3 - 2 * t)
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
