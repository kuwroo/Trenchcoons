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
// …and the vertical axis is left to the suspension. Climbable rocks (medium
// and below) feed their top into the wheel heightfield via `rideHeightAt`, so
// the kart rides up them like a ramp; only tall solids (boulders, trunks)
// produce a hard horizontal block.

import * as THREE from 'three/webgpu'
import type { Vehicle } from '../vehicle/vehicle'
import { polyInset, polyPush, type ProxyPoly } from './proxy'
import type { SolidInstance } from './scatter'

/**
 * Radius of the chassis disc, metres.
 *
 * Shrunk from 1.05: the old disc reached past the bumper and snagged every
 * pebble beside the wheels. Half-width of the box is ~0.8 m; 0.70 sits inside
 * the visible body so small rocks glance under / past.
 */
const KART_RADIUS = 0.70
/**
 * How much of the incoming speed comes back as a bounce.
 *
 * Small on purpose. A cardboard box hitting a rock should stop and lurch, not
 * ricochet — and anything springy here fights the chase camera, which is a
 * stack of critically-damped springs following a body that is now oscillating.
 */
const RESTITUTION = 0.18
/**
 * Chassis underside clearance below the axle, metres.
 *
 * The collision volume's floor sits at `axleY - CLEARANCE`. A SMALLER value
 * raises that floor, so low rocks pass under the hitbox. 0.10 clears pebbles
 * and the low end of rock-small; medium rocks are handled as ramps instead.
 */
const CLEARANCE = 0.10
/**
 * Tallest solid the wheels will ride as a ramp, metres of proxy height.
 *
 * rock-medium (incl. scale jitter) tops out around 2 m of proxy height;
 * boulder-large / outcrops / trunks sit well above and stay hard blockers.
 * Climbables contribute to `rideHeightAt` so the suspension walks up them.
 */
const CLIMB_MAX = 2.15
/** Solver passes. Two is enough to get out of a corner between two rocks. */
const PASSES = 2

const _push = { x: 0, z: 0, depth: 0 }

export interface CollisionState {
  /** True on any frame the chassis is being pushed out of something. */
  contact: boolean
  /** Speed lost to the last impact, m/s. Drives audio and, later, damage. */
  impact: number
}

function solidHeight(s: SolidInstance): number {
  return (s.poly.top - s.poly.bottom) * s.scale
}

function isClimbable(s: SolidInstance): boolean {
  return solidHeight(s) <= CLIMB_MAX
}

/** Local-space inset of a world XZ into a solid's footprint. */
function solidInset(s: SolidInstance, x: number, z: number): number {
  const dx = x - s.x
  const dz = z - s.z
  if (dx * dx + dz * dz > (s.radius + 0.5) * (s.radius + 0.5)) return -Infinity
  const inv = 1 / s.scale
  const lx = (dx * s.cos - dz * s.sin) * inv
  const lz = (dx * s.sin + dz * s.cos) * inv
  // Inset is in local units; convert to world metres.
  return polyInset(s.poly.points, lx, lz) * s.scale
}

export class ObjectCollision {
  readonly state: CollisionState = { contact: false, impact: 0 }

  constructor(private readonly solids: readonly SolidInstance[]) {}

  /**
   * Ground height under a wheel once climbable solids are folded in.
   *
   * Near a rock's rim the height eases from `groundY` up to the proxy top over
   * ~0.7 m of inset, so the kart walks up medium rocks like a ramp instead of
   * hitting a vertical step the moment a tyre crosses the silhouette.
   */
  rideHeightAt(x: number, z: number, groundY: number): number {
    let y = groundY
    for (const s of this.solids) {
      if (!isClimbable(s)) continue
      const inset = solidInset(s, x, z)
      if (inset < 0) continue
      const ramp = Math.min(0.85, Math.max(0.35, s.radius * 0.4))
      const t = inset >= ramp ? 1 : (inset / ramp) * (inset / ramp) * (3 - 2 * (inset / ramp))
      const target = groundY + t * Math.max(0, s.topY - groundY)
      if (target > y) y = target
    }
    return y
  }

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
        // Drive-under: raised hitbox floor. Low rocks never become a wall.
        if (s.topY < p.y - CLEARANCE) continue
        // Climbable solids are ramps via rideHeightAt — do not hard-block.
        if (isClimbable(s)) continue
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
