// Collision proxies, flattened for the kart.
//
// The modeller ships an exact proxy per asset — a convex hull for anything cut
// by plane intersection, one hull PER COURSE for a stepped outcrop, an upright
// cylinder on a conifer's bole, and an explicit `{ shapes: [], solid: false }`
// for grass. This turns that into the one query the kart actually makes.
//
// WHY XZ AND NOT 3D. The vehicle is a raycast-suspension kart: it has no rigid
// body, no inertia tensor and no contact manifold — it samples `heightAt` under
// four wheels and integrates a velocity. The only collision response that
// composes with that is a horizontal one: push the chassis out of the footprint
// and kill the component of velocity going into it. A full 3D hull would give
// us contact points nothing downstream could consume, so the proxy is projected
// to a convex polygon in XZ plus a vertical extent, and the vertical extent is
// used to decide whether the obstacle blocks at all — a slab whose top is below
// the axle line is something you drive over, not into.
//
// The projection is conservative in exactly one direction (it merges the
// courses of a stepped outcrop into their common shadow), which for a HORIZONTAL
// query is what you want anyway: you cannot drive between two stacked shelves.

import type { Collider, ColliderShape } from '../assets'

export interface ProxyPoly {
  /** Convex polygon in the asset's local XZ, wound counter-clockwise. */
  points: Float32Array
  /** Local Y of the top of the solid, metres. */
  top: number
  /** Local Y of the bottom. */
  bottom: number
  /** Circumradius about the local origin. Broad-phase. */
  radius: number
}

/** Approximating a round shape. 10 sides is under 5% inside the true circle. */
const CIRCLE_SIDES = 10

function pushCircle(out: number[], cx: number, cz: number, r: number): void {
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const a = (i / CIRCLE_SIDES) * Math.PI * 2
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r)
  }
}

function shapePoints(s: ColliderShape, out: number[]): { lo: number; hi: number } {
  switch (s.kind) {
    case 'hull': {
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < s.points.length; i += 3) {
        out.push(s.points[i]!, s.points[i + 2]!)
        const y = s.points[i + 1]!
        if (y < lo) lo = y
        if (y > hi) hi = y
      }
      return { lo, hi }
    }
    case 'box': {
      const [hx, hy, hz] = s.half
      const c = Math.cos(s.yaw)
      const sn = Math.sin(s.yaw)
      for (const [dx, dz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] as const) {
        out.push(s.at[0] + dx * c - dz * sn, s.at[2] + dx * sn + dz * c)
      }
      return { lo: s.at[1] - hy, hi: s.at[1] + hy }
    }
    case 'sphere':
      pushCircle(out, s.at[0], s.at[2], s.radius)
      return { lo: s.at[1] - s.radius, hi: s.at[1] + s.radius }
    case 'capsule':
    case 'cylinder':
      pushCircle(out, s.at[0], s.at[2], s.radius)
      return {
        lo: s.at[1] - s.halfHeight - (s.kind === 'capsule' ? s.radius : 0),
        hi: s.at[1] + s.halfHeight + (s.kind === 'capsule' ? s.radius : 0),
      }
  }
}

/** Andrew's monotone chain. Counter-clockwise, no collinear points. */
function convexHull2(pts: number[]): Float32Array {
  const n = pts.length / 2
  if (n < 3) return new Float32Array(pts)
  const idx = Array.from({ length: n }, (_, i) => i)
  idx.sort((a, b) => (pts[a * 2]! - pts[b * 2]!) || (pts[a * 2 + 1]! - pts[b * 2 + 1]!))
  const cross = (o: number, a: number, b: number): number =>
    (pts[a * 2]! - pts[o * 2]!) * (pts[b * 2 + 1]! - pts[o * 2 + 1]!)
    - (pts[a * 2 + 1]! - pts[o * 2 + 1]!) * (pts[b * 2]! - pts[o * 2]!)
  const build = (order: number[]): number[] => {
    const st: number[] = []
    for (const i of order) {
      while (st.length >= 2 && cross(st[st.length - 2]!, st[st.length - 1]!, i) <= 0) st.pop()
      st.push(i)
    }
    st.pop()
    return st
  }
  const lower = build(idx)
  const upper = build([...idx].reverse())
  const hull = [...lower, ...upper]
  const out = new Float32Array(hull.length * 2)
  for (let i = 0; i < hull.length; i++) {
    out[i * 2] = pts[hull[i]! * 2]!
    out[i * 2 + 1] = pts[hull[i]! * 2 + 1]!
  }
  return out
}

/** Flatten a collider. Null when the asset is not solid or has no shapes. */
export function buildProxy(collider: Collider): ProxyPoly | null {
  if (!collider.solid || collider.shapes.length === 0) return null
  const pts: number[] = []
  let bottom = Infinity
  let top = -Infinity
  for (const s of collider.shapes) {
    const { lo, hi } = shapePoints(s, pts)
    if (lo < bottom) bottom = lo
    if (hi > top) top = hi
  }
  if (pts.length < 6) return null
  const points = convexHull2(pts)
  if (points.length < 6) return null
  let radius = 0
  for (let i = 0; i < points.length; i += 2) {
    radius = Math.max(radius, Math.hypot(points[i]!, points[i + 1]!))
  }
  return { points, top, bottom, radius }
}

/** True when (px, pz) is inside the convex polygon (or on the boundary). */
export function polyContains(poly: Float32Array, px: number, pz: number): boolean {
  return polyInset(poly, px, pz) >= 0
}

/**
 * Signed distance to the polygon boundary in the polygon's plane.
 * Positive = inside (metres to the nearest edge), negative = outside.
 */
export function polyInset(poly: Float32Array, px: number, pz: number): number {
  const n = poly.length / 2
  if (n < 3) return -Infinity
  let minInside = Infinity
  let minOutside = Infinity
  let inside = true
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!
    const az = poly[i * 2 + 1]!
    const j = (i + 1) % n
    const bx = poly[j * 2]!
    const bz = poly[j * 2 + 1]!
    const ex = bx - ax
    const ez = bz - az
    const len = Math.hypot(ex, ez) || 1e-6
    // Counter-clockwise winding → outward normal (ez, -ex). Inside ⇒ d <= 0.
    const d = (px - ax) * (ez / len) + (pz - az) * (-ex / len)
    if (d > 1e-5) inside = false
    if (d <= 0) minInside = Math.min(minInside, -d)
    // Distance to segment for the outside case.
    let t = ((px - ax) * ex + (pz - az) * ez) / (len * len)
    t = t < 0 ? 0 : t > 1 ? 1 : t
    minOutside = Math.min(minOutside, Math.hypot(px - (ax + ex * t), pz - (az + ez * t)))
  }
  return inside ? (Number.isFinite(minInside) ? minInside : 0) : -minOutside
}

/**
 * Closest-point query against a convex polygon.
 *
 * Returns the outward push needed to get a disc of radius `r` centred at
 * (px, pz) clear of the polygon, or null when it is already clear. Handles the
 * inside case as well as the outside one, because a car that has tunnelled in
 * at 35 m/s still has to come out the nearest side rather than through the
 * middle.
 */
export function polyPush(
  poly: Float32Array, px: number, pz: number, r: number,
  out: { x: number; z: number; depth: number },
): boolean {
  const n = poly.length / 2
  let inside = true
  let bestEdgeDist = -Infinity
  let bestNx = 0
  let bestNz = 0
  let bestOutDist = Infinity
  let bestOutX = 0
  let bestOutZ = 0
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!
    const az = poly[i * 2 + 1]!
    const j = (i + 1) % n
    const bx = poly[j * 2]!
    const bz = poly[j * 2 + 1]!
    const ex = bx - ax
    const ez = bz - az
    const len = Math.hypot(ex, ez) || 1e-6
    // Counter-clockwise winding, so the outward normal is (ez, -ex).
    const nx = ez / len
    const nz = -ex / len
    const d = (px - ax) * nx + (pz - az) * nz
    if (d > 0) inside = false
    if (d > bestEdgeDist) { bestEdgeDist = d; bestNx = nx; bestNz = nz }
    // Closest point on this segment, for the outside case.
    let t = ((px - ax) * ex + (pz - az) * ez) / (len * len)
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const cx = ax + ex * t
    const cz = az + ez * t
    const dist = Math.hypot(px - cx, pz - cz)
    if (dist < bestOutDist) { bestOutDist = dist; bestOutX = px - cx; bestOutZ = pz - cz }
  }
  if (inside) {
    out.x = bestNx
    out.z = bestNz
    out.depth = r - bestEdgeDist // bestEdgeDist is negative inside
    return true
  }
  if (bestOutDist >= r) return false
  const inv = 1 / (bestOutDist || 1e-6)
  out.x = bestOutX * inv
  out.z = bestOutZ * inv
  out.depth = r - bestOutDist
  return true
}
