// Kart versus scattered forms.
//
// "can i have ... collisions with rocks and objects?" — this is that, and it is
// deliberately OUTSIDE src/vehicle. The driving model is signed off and must
// not regress, and it turns out the seam is a good one anyway: `Vehicle.update`
// reads its velocity at the top of the step and recomposes it at the bottom, so
// an external correction applied between frames is indistinguishable from one
// the model made itself. The deformation coupling in src/deform/index.ts uses
// the same seam for the same reason.
//
// The kart is a raycast-suspension chassis, not a rigid body: there is no
// contact manifold to solve and no inertia tensor to apply an impulse through.
// So the response is the one that composes with that model —
//
//   1. push the chassis out of the proxy's XZ footprint along the shortest exit
//   2. remove the component of velocity heading INTO the surface
//   3. keep a little of it as a bounce, so hitting a boulder reads as an impact
//      rather than as the car quietly stopping
//
// …and the vertical axis is left entirely to the suspension, which is already
// sampling the heightfield. An obstacle whose top is below the chassis is not a
// collision at all: you drive over a slab, you do not stop against it.

import * as THREE from 'three/webgpu'
import type { Vehicle } from '../vehicle/vehicle'
import { polyPush, type ProxyPoly } from './proxy'
import type { SolidInstance } from './scatter'

/**
 * Radius of the chassis disc, metres.
 *
 * The kart is 2.7 x 1.6 m. A disc is the right approximation here rather than a
 * box because the proxies are already convex and the response is a push along a
 * surface normal: a box would need an SAT solve to produce the same number, and
 * the difference is under half a metre on a form whose own footprint is 2-8 m.
 * Sized between the half-width and the half-length so a nose-on hit stops the
 * car about where the bumper is.
 */
const KART_RADIUS = 1.05
/**
 * How much of the incoming speed comes back as a bounce.
 *
 * Small on purpose. A cardboard box hitting a rock should stop and lurch, not
 * ricochet — and anything springy here fights the chase camera, which is a
 * stack of critically-damped springs following a body that is now oscillating.
 */
const RESTITUTION = 0.18
/**
 * Chassis clearance, metres. An obstacle whose top is below the chassis origin
 * minus this is driven over.
 */
const CLEARANCE = 0.28
/** Solver passes. Two is enough to get out of a corner between two rocks. */
const PASSES = 2

const _push = { x: 0, z: 0, depth: 0 }

export interface CollisionState {
  /** True on any frame the chassis is being pushed out of something. */
  contact: boolean
  /** Speed lost to the last impact, m/s. Drives audio and, later, damage. */
  impact: number
}

export class ObjectCollision {
  readonly state: CollisionState = { contact: false, impact: 0 }

  constructor(private readonly solids: readonly SolidInstance[]) {}

  /**
   * Resolve, in place. Call AFTER `Vehicle.update` and before anything that
   * reads the pose — the kart visuals, the contact shadow, the chase camera.
   */
  resolve(vehicle: Vehicle): void {
    this.state.contact = false
    this.state.impact = 0
    const p = vehicle.object.position
    const v = vehicle.velocity
    const before = Math.hypot(v.x, v.z)
    let touched = false

    for (let pass = 0; pass < PASSES; pass++) {
      let moved = false
      for (const s of this.solids) {
        const dx = p.x - s.x
        const dz = p.z - s.z
        const reach = s.radius + KART_RADIUS
        if (dx * dx + dz * dz > reach * reach) continue
        // Drive-over test. `topY` is the world top of the proxy; the chassis
        // origin sits on the axle line, so anything below it clears.
        if (s.topY < p.y - CLEARANCE) continue
        if (!pushOut(s, p, v)) continue
        moved = true
        touched = true
      }
      if (!moved) break
    }

    if (touched) {
      this.state.contact = true
      this.state.impact = Math.max(0, before - Math.hypot(v.x, v.z))
    }
  }
}

/** One instance. Returns true if it pushed. */
function pushOut(s: SolidInstance, p: THREE.Vector3, v: THREE.Vector3): boolean {
  // World -> instance local: translate, un-yaw, un-scale. The instance matrix is
  // compose(position, yaw, uniform scale), so the inverse is exactly this.
  const dx = p.x - s.x
  const dz = p.z - s.z
  const inv = 1 / s.scale
  // R_y(-yaw) on (x, z) with (cos, sin) = (s.cos, s.sin).
  const lx = (dx * s.cos - dz * s.sin) * inv
  const lz = (dx * s.sin + dz * s.cos) * inv
  if (!polyPush(s.poly.points, lx, lz, KART_RADIUS * inv, _push)) return false

  // Local normal -> world: R_y(yaw), which is the transpose of the above.
  const nx = _push.x * s.cos + _push.z * s.sin
  const nz = -_push.x * s.sin + _push.z * s.cos
  const len = Math.hypot(nx, nz) || 1
  const ux = nx / len
  const uz = nz / len
  const depth = _push.depth * s.scale
  p.x += ux * depth
  p.z += uz * depth

  const vn = v.x * ux + v.z * uz
  if (vn < 0) {
    const k = vn * (1 + RESTITUTION)
    v.x -= ux * k
    v.z -= uz * k
  }
  return true
}

export type { ProxyPoly }
