// Collision proxies.
//
// This is a HARD DEPENDENCY for the world team, not a nicety: without a proxy
// per asset there is no way to collide the kart against anything scattered, and
// the greybox's `Obstacle` list — a circle in XZ — is only good enough to keep
// a spawn out of a bush. It cannot stop a car.
//
// Every proxy is authored in the asset's LOCAL space, before the instance
// transform, so a scatter instance is `collider x instanceMatrix` and nothing
// has to be regenerated per instance. Convex hulls come straight out of the
// generator for anything built by plane-clipping (see hull.ts — the render mesh
// IS a convex solid there, so the proxy is exact and free). Everything else
// gets primitives, because a capsule around a trunk is both cheaper and BETTER
// than a hull around a tree: the player expects to drive through the canopy.

import { hullOf } from './hull'
import { MeshBuilder, ring, loft, type Vec3 } from './mesh'
import type { AssetBounds, Collider, ColliderShape } from './types'
import type * as THREE from 'three/webgpu'

/**
 * Convex hull proxy.
 *
 * @param inflate Metres to push every support plane out by. 0.04 by default:
 *   the kart's own collision is resolved against the proxy, so a proxy flush
 *   with the render mesh lets a wheel visibly touch the rock before it stops.
 *   Four centimetres is under a pixel at any distance the contact is visible.
 */
export function hullShape(points: readonly Vec3[], inflate = 0.04): ColliderShape {
  const solid = hullOf(points, undefined, inflate)
  const pts = solid.points()
  const flat = new Float32Array(pts.length * 3)
  for (let i = 0; i < pts.length; i++) {
    flat[i * 3] = pts[i]![0]
    flat[i * 3 + 1] = pts[i]![1]
    flat[i * 3 + 2] = pts[i]![2]
  }
  return { kind: 'hull', points: flat }
}

export const sphereShape = (radius: number, at: Vec3 = [0, 0, 0]): ColliderShape =>
  ({ kind: 'sphere', radius, at: [at[0], at[1], at[2]] })

export const capsuleShape = (
  radius: number, halfHeight: number, at: Vec3 = [0, 0, 0],
): ColliderShape => ({ kind: 'capsule', radius, halfHeight, at: [at[0], at[1], at[2]] })

export const cylinderShape = (
  radius: number, halfHeight: number, at: Vec3 = [0, 0, 0],
): ColliderShape => ({ kind: 'cylinder', radius, halfHeight, at: [at[0], at[1], at[2]] })

export const boxShape = (
  half: Vec3, at: Vec3 = [0, 0, 0], yaw = 0,
): ColliderShape => ({
  kind: 'box', half: [half[0], half[1], half[2]], at: [at[0], at[1], at[2]], yaw,
})

/** Vegetation the kart drives straight through. Still answers the question. */
export const noCollision = (): Collider => ({ shapes: [], solid: false })

export const solidCollider = (...shapes: ColliderShape[]): Collider =>
  ({ shapes, solid: true })

export function boundsFromPoints(points: readonly Vec3[]): AssetBounds {
  let footprint = 0
  let radius = 0
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of points) {
    footprint = Math.max(footprint, Math.hypot(p[0], p[2]))
    radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]))
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
  }
  if (!Number.isFinite(y0)) return { footprint: 0, height: 0, radius: 0 }
  return { footprint, height: y1 - y0, radius }
}

/**
 * Renderable geometry for a proxy, for the Forge's collision overlay.
 *
 * Debug-only, and it is the difference between "the collider is probably fine"
 * and looking at it. A proxy that is silently 30% too small is invisible in
 * every screenshot until a car drives through a boulder.
 */
export function colliderGeometry(collider: Collider): THREE.BufferGeometry | null {
  if (collider.shapes.length === 0) return null
  const b = new MeshBuilder()
  for (const s of collider.shapes) {
    switch (s.kind) {
      case 'hull': {
        const pts: Vec3[] = []
        for (let i = 0; i + 2 < s.points.length; i += 3) {
          pts.push([s.points[i]!, s.points[i + 1]!, s.points[i + 2]!])
        }
        hullOf(pts).emit(b)
        break
      }
      case 'sphere':
        loft(b, latRings(s.radius, s.radius, s.at, 6, 9), { capStart: false, capEnd: false })
        break
      case 'capsule':
        loft(b, latRings(s.radius, s.radius + s.halfHeight, s.at, 6, 9), {})
        break
      case 'cylinder':
        loft(b, [
          ring(10, s.radius, s.at[1] - s.halfHeight, 0, s.at[0], s.at[2]),
          ring(10, s.radius, s.at[1] + s.halfHeight, 0, s.at[0], s.at[2]),
        ], { capStart: true, capEnd: true })
        break
      case 'box': {
        const [hx, hy, hz] = s.half
        const c = Math.cos(s.yaw)
        const sn = Math.sin(s.yaw)
        const corner = (x: number, y: number, z: number): Vec3 =>
          [s.at[0] + x * c + z * sn, s.at[1] + y, s.at[2] - x * sn + z * c]
        loft(b, [
          [corner(-hx, -hy, -hz), corner(hx, -hy, -hz), corner(hx, -hy, hz), corner(-hx, -hy, hz)],
          [corner(-hx, hy, -hz), corner(hx, hy, -hz), corner(hx, hy, hz), corner(-hx, hy, hz)],
        ], { capStart: true, capEnd: true })
        break
      }
    }
  }
  return b.build()
}

/** Latitude rings for a sphere or capsule of half-height `hh` about `at`. */
function latRings(
  radius: number, hh: number, at: [number, number, number], lat: number, seg: number,
): Vec3[][] {
  const cyl = Math.max(0, hh - radius)
  const rings: Vec3[][] = []
  for (let i = 0; i <= lat; i++) {
    const t = i / lat
    const a = -Math.PI * 0.5 + t * Math.PI
    const y = Math.sin(a) * radius + (a < 0 ? -cyl : cyl)
    const r = Math.cos(a) * radius
    rings.push(ring(seg, Math.max(1e-3, r), at[1] + y, 0, at[0], at[2]))
  }
  return rings
}
