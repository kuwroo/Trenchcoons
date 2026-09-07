// Procedural multi-path network (world XZ metres).
//
// Port of overgrown-portfolio/src/app/pathCurve.js — main spine + cross trail +
// side spur. Tiled every PATH_TILE metres so the open world is not stuck with a
// single corridor at the origin. Used by terrain dirt blend, grass clearance,
// and scatter culling. Do not reintroduce the old noise-contour pathAt.

import { abs, cos, float, floor, min, mix, saturate, sin, sqrt } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Tile period — matches overgrown GrassField / dirt plane size. */
export const PATH_TILE = 240

/** Main N–S spine: local X as function of local Z (overgrown pathMainX). */
export function pathMainX(z: number): number {
  return (
    Math.sin(z * 0.072 + 0.35) * 4.2 +
    Math.sin(z * 0.041 - 0.9) * 2.4 +
    Math.sin(z * 0.12 + 1.1) * 1.3 +
    Math.cos(z * 0.028 + 0.2) * 1.1
  )
}

/** E–W cross trail: local Z as function of local X. */
export function pathCrossZ(x: number): number {
  return (
    12 +
    Math.sin(x * 0.055 + 0.4) * 3.5 +
    Math.cos(x * 0.09 - 0.6) * 2.0 +
    Math.sin(x * 0.13) * 1.1
  )
}

/** Side spur (secondary N–S, offset east). */
export function pathSpurX(z: number): number {
  return (
    18 +
    Math.sin(z * 0.06 + 1.7) * 3.0 +
    Math.cos(z * 0.1 - 0.3) * 1.6
  )
}

/** Tangent of main spine in a tile's local frame. */
export function pathTangent(z: number, eps = 0.4): { x: number; z: number } {
  const x0 = pathMainX(z - eps)
  const x1 = pathMainX(z + eps)
  let tx = x1 - x0
  let tz = eps * 2
  const len = Math.hypot(tx, tz) || 1
  return { x: tx / len, z: tz / len }
}

function distToPathLocal(lx: number, lz: number): number {
  let d = Math.abs(lx - pathMainX(lz))
  d = Math.min(d, Math.abs(lz - pathCrossZ(lx)))
  if (lz > -5) {
    d = Math.min(d, Math.abs(lx - pathSpurX(lz)))
  }
  const jx = pathMainX(pathCrossZ(0))
  const jz = pathCrossZ(0)
  const toJ = Math.hypot(lx - jx, lz - jz)
  if (toJ < 14) {
    d = Math.min(d, toJ * 0.35)
  }
  return d
}

/**
 * Distance to nearest tiled path network copy.
 * Same shape as overgrown; repeated on a PATH_TILE lattice for the open world.
 */
export function distToPath(x: number, z: number): number {
  const TILE = PATH_TILE
  const cx = Math.round(x / TILE) * TILE
  const cz = Math.round(z / TILE) * TILE
  let best = Infinity
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const ox = cx + di * TILE
      const oz = cz + dj * TILE
      best = Math.min(best, distToPathLocal(x - ox, z - oz))
    }
  }
  return best
}

/** 1 at path center → 0 far away. Overgrown default halfWidth 3.2. */
export function pathCorridorWeight(x: number, z: number, halfWidth = 3.2): number {
  const d = distToPath(x, z)
  return Math.exp(-(d * d) / (2 * halfWidth * halfWidth))
}

/** Overgrown World.ts roadHalfWidth for grass / tree clearance. */
export const ROAD_HALF = 1.85

/** Dirt paint half-widths from overgrown environment.ts alpha maps. */
export const PATH_SOLID_M = 0.65
export const PATH_FADE_M = 1.7
export const SHOULDER_SOLID_M = 1.05
export const SHOULDER_FADE_M = 3.4

/** Warm dirt colours from overgrown Ground_DirtPath / Ground_DirtShoulders. */
export const DIRT_PATH = 0xd8b888
export const DIRT_SHOULDER = 0xc8a878

// ── TSL mirror for the ground shader ─────────────────────────────────────────

function pathMainXNode(z: Node<'float'>): Node<'float'> {
  return sin(z.mul(0.072).add(0.35)).mul(4.2)
    .add(sin(z.mul(0.041).sub(0.9)).mul(2.4))
    .add(sin(z.mul(0.12).add(1.1)).mul(1.3))
    .add(cos(z.mul(0.028).add(0.2)).mul(1.1))
}

function pathCrossZNode(x: Node<'float'>): Node<'float'> {
  return float(12)
    .add(sin(x.mul(0.055).add(0.4)).mul(3.5))
    .add(cos(x.mul(0.09).sub(0.6)).mul(2.0))
    .add(sin(x.mul(0.13)).mul(1.1))
}

function pathSpurXNode(z: Node<'float'>): Node<'float'> {
  return float(18)
    .add(sin(z.mul(0.06).add(1.7)).mul(3.0))
    .add(cos(z.mul(0.1).sub(0.3)).mul(1.6))
}

function smoothGate(v: Node<'float'>, edge0: number, edge1: number): Node<'float'> {
  const t = saturate(v.sub(edge0).div(edge1 - edge0))
  return t.mul(t).mul(float(3).sub(t.mul(2)))
}

function distToPathLocalNode(lx: Node<'float'>, lz: Node<'float'>): Node<'float'> {
  const dMain = abs(lx.sub(pathMainXNode(lz)))
  const dCross = abs(lz.sub(pathCrossZNode(lx)))
  let d = min(dMain, dCross)
  const spurOn = smoothGate(lz, -5, -3)
  const dSpur = abs(lx.sub(pathSpurXNode(lz)))
  d = min(d, mix(float(1e3), dSpur, spurOn))
  const jz = pathCrossZNode(float(0))
  const jx = pathMainXNode(jz)
  const toJ = sqrt(lx.sub(jx).mul(lx.sub(jx)).add(lz.sub(jz).mul(lz.sub(jz))))
  const jGate = smoothGate(float(14).sub(toJ), 0, 2)
  d = min(d, mix(float(1e3), toJ.mul(0.35), jGate))
  return d
}

/** Nearest tile centre: round(v / TILE) * TILE */
function nearestTileCentre(v: Node<'float'>): Node<'float'> {
  const TILE = float(PATH_TILE)
  return floor(v.div(TILE).add(0.5)).mul(TILE)
}

/** TSL distance to nearest tiled path — matches `distToPath`. */
export function distToPathNode(x: Node<'float'>, z: Node<'float'>): Node<'float'> {
  const TILE = float(PATH_TILE)
  const cx = nearestTileCentre(x)
  const cz = nearestTileCentre(z)
  let d: Node<'float'> = float(1e4)
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const ox = cx.add(di * PATH_TILE)
      const oz = cz.add(dj * PATH_TILE)
      d = min(d, distToPathLocalNode(x.sub(ox), z.sub(oz)))
    }
  }
  return d
}

/**
 * Dirt coverage 0..1 from distance, matching createWindingDirtAlphaMap's
 * solid/fade envelope (without the FBM edge wobble — ground already has tone).
 */
export function dirtAlphaNode(
  dist: Node<'float'>, solidM: number, fadeM: number, peak = 1,
): Node<'float'> {
  const solid = float(solidM)
  const fade = float(Math.max(fadeM, solidM + 0.15))
  const t = saturate(dist.sub(solid).div(fade.sub(solid)))
  const a = float(1).sub(t.mul(t).mul(float(3).sub(t.mul(2))))
  const outer = a.mul(a)
  const past = saturate(dist.sub(solid).mul(1000))
  return saturate(mix(float(1), outer, past).mul(peak))
}
