// The kart: a cardboard box with two raccoons in a trenchcoat in it.
//
// Everything here is procedural motion over static geometry — there is no rig
// and nothing is keyframed (MILESTONES M3: "there are no rigged assets, so
// nothing here is keyframed"). The parts are posed from TRS every frame, and
// every quantity that changes goes through a spring in core/spring.ts.
//
// The idle layer is the point of the milestone, not decoration: "a parked,
// untouched car must never be a still image". It is cross-faded by the
// vehicle's own `idle` telemetry rather than switched, and it never fades to
// zero — a moving car still breathes, its occupants still lean, the coat still
// swings.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { PainterlyMaterial } from '../material/painterly'
import { surface } from '../material/defs'
import { AngleSpring, Spring, clamp, saturate, sway } from '../core/spring'
import type { Vehicle } from './vehicle'
import { PosedInstances, blob, roundedBox, wheelGeometry } from './geometry'

/**
 * Kart dimensions, chassis space. y = 0 is the suspension anchor plane, so the
 * ground sits at -(rest + wheelRadius) = -0.74 and every number below can be
 * read as "height above the axle line".
 */
const BOX = { w: 1.72, h: 1.06, d: 2.68, r: 0.2 }
const BOX_Y = 0.4
const RIM_Y = BOX_Y + BOX.h * 0.5
const FLAP = { len: 0.66, thick: 0.07, rest: 1.0 }
const HEAD = { x: 0.34, y: 1.5, z: -0.1, r: 0.29 }

/** Deterministic 0..1 hash. No Math.random in generation, ever. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

interface Occupant {
  side: number
  phase: number
  glanceYaw: AngleSpring
  glancePitch: Spring
  bob: Spring
  lid: Spring
  glanceSlot: number
}

export class Kart {
  /** Parented to `vehicle.object`. */
  readonly root = new THREE.Group()
  readonly materials: PainterlyMaterial[] = []

  /** Squash and breathing act on this; the wheels must not inherit them. */
  private readonly body = new THREE.Group()

  private readonly wheels: PosedInstances
  private readonly hubs: PosedInstances
  /** Trailing arm from the chassis down to each hub. */
  private readonly struts: PosedInstances
  private readonly flaps: PosedInstances
  private readonly heads: PosedInstances
  private readonly ears: PosedInstances
  private readonly masks: PosedInstances
  private readonly muzzles: PosedInstances
  private readonly eyes: PosedInstances
  private readonly coat: THREE.Mesh
  private readonly collar: THREE.Mesh

  // ── springs ───────────────────────────────────────────────────────────────
  /** One per flap. Underdamped so a gust makes them flutter, not swing once. */
  private readonly flapSprings: Spring[] = []
  private readonly coatRoll = new Spring(0, 1.1, 0.45)
  private readonly coatPitch = new Spring(0, 1.25, 0.5)
  private readonly occupants: Occupant[] = []

  private readonly p = new THREE.Vector3()
  private readonly s = new THREE.Vector3()

  constructor(atmosphere: Atmosphere) {
    const mat = (id: string): THREE.Material => {
      const m = new PainterlyMaterial(atmosphere, surface(id))
      this.materials.push(m)
      return m.material
    }
    const cardboard = mat('cardboard')
    const flapMat = mat('cardboardFlap')
    const tyre = mat('tyre')
    const fur = mat('fur')
    const furLight = mat('furLight')
    const maskMat = mat('mask')
    const coatMat = mat('coat')
    const eyeMat = mat('eye')
    const hubMat = mat('hub')

    this.root.name = 'kart'
    this.root.add(this.body)

    // ── the box ────────────────────────────────────────────────────────────
    const boxMesh = new THREE.Mesh(roundedBox(BOX.w, BOX.h, BOX.d, BOX.r, 4), cardboard)
    boxMesh.position.y = BOX_Y
    boxMesh.name = 'kart-box'
    boxMesh.frustumCulled = false
    this.body.add(boxMesh)

    // ── flaps: one geometry, hinged at its own origin ──────────────────────
    // Built spanning y 0..len so the instance rotation IS the hinge. Unit width
    // in x, scaled per instance, which is what lets the long side flaps and the
    // short end flaps share a batch.
    const flapGeo = roundedBox(1, FLAP.len, FLAP.thick, 0.03, 2)
    flapGeo.translate(0, FLAP.len * 0.5, 0)
    this.flaps = new PosedInstances(flapGeo, flapMat, 4, 'kart-flaps')
    this.body.add(this.flaps.mesh)
    for (let i = 0; i < 4; i++) this.flapSprings.push(new Spring(FLAP.rest, 2.3 + i * 0.21, 0.42))

    // ── trenchcoat: one coat, two raccoons. That is the whole joke. ─────────
    const coatGeo = new THREE.CylinderGeometry(0.5, 0.68, 0.7, 18, 1, true)
    this.coat = new THREE.Mesh(coatGeo, coatMat)
    this.coat.position.set(0, 1.03, -0.06)
    this.coat.scale.set(1, 1, 0.8)
    this.coat.name = 'kart-coat'
    this.coat.frustumCulled = false
    this.body.add(this.coat)

    this.collar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.5, 0.15, 18, 1, true), coatMat)
    this.collar.position.set(0, 1.4, -0.06)
    this.collar.scale.set(1, 1, 0.82)
    this.collar.name = 'kart-collar'
    this.collar.frustumCulled = false
    this.body.add(this.collar)

    // ── occupants ──────────────────────────────────────────────────────────
    this.heads = new PosedInstances(blob(HEAD.r, 14), fur, 2, 'kart-heads')
    this.ears = new PosedInstances(blob(0.105, 10), fur, 4, 'kart-ears')
    this.masks = new PosedInstances(blob(HEAD.r * 1.02, 14), maskMat, 2, 'kart-masks')
    this.muzzles = new PosedInstances(blob(0.13, 10), furLight, 2, 'kart-muzzles')
    this.eyes = new PosedInstances(blob(0.052, 8), eyeMat, 4, 'kart-eyes')
    for (const b of [this.heads, this.masks, this.muzzles, this.ears, this.eyes]) {
      this.body.add(b.mesh)
    }
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      this.occupants.push({
        side,
        phase: hash(i * 7 + 3),
        // Underdamped: a glance arrives slightly past where it was going and
        // settles, which is most of what makes it read as alive.
        glanceYaw: new AngleSpring(0, 1.15, 0.5),
        glancePitch: new Spring(0, 1.3, 0.6),
        bob: new Spring(0, 1.6, 0.6),
        lid: new Spring(0, 9, 0.85),
        glanceSlot: -1,
      })
    }

    // ── wheels ─────────────────────────────────────────────────────────────
    this.wheels = new PosedInstances(wheelGeometry(0.4, 0.3, 14), tyre, 4, 'kart-wheels')
    this.hubs = new PosedInstances(wheelGeometry(0.19, 0.34, 10), hubMat, 4, 'kart-hubs')

    // A visible link between the body and the hub. Without one there is no
    // geometry at all between the box and the tyre, and at full 0.26 m droop —
    // car-airborne, and the unloaded corner in car-corner — all four tyres hang
    // in open space with grass showing through the gap. That reads as broken
    // parenting, not as suspension. The arm spans y 0..-1 in its own space and
    // is scaled to `hubDrop` per frame, so the travel is what makes it stretch.
    const strutGeo = roundedBox(0.115, 1, 0.15, 0.05, 2)
    strutGeo.translate(0, -0.5, 0)
    this.struts = new PosedInstances(strutGeo, hubMat, 4, 'kart-struts')
    this.root.add(this.wheels.mesh, this.hubs.mesh, this.struts.mesh)
  }

  /**
   * `elapsed` is the deterministic clock, so the idle layer is frame-exact in a
   * capture. `dt` of 0 must leave everything untouched — the shot harness
   * freezes the clock and keeps rendering.
   */
  update(dt: number, elapsed: number, vehicle: Vehicle): void {
    const t = vehicle.telemetry
    const speedNorm = saturate(t.speed / 35)
    // The idle layer never switches off, it only quietens: a driving car still
    // breathes. 1 parked, ~0.3 flat out.
    const amp = 0.3 + 0.7 * t.idle

    // ── the box breathes ───────────────────────────────────────────────────
    const b = sway(elapsed, 0.28)
    const sq = t.squash
    // Volume-ish conservation: squash down, spread out. Scaling about y = 0
    // keeps the base sitting on the wheels instead of sinking through them.
    this.body.scale.set(
      1 + sq * 0.42 - 0.009 * b * amp,
      1 - sq - 0.0 + 0.017 * b * amp,
      1 + sq * 0.42 - 0.009 * b * amp,
    )
    this.body.position.y = 0.012 * b * amp

    // ── flaps: blown open by speed, fluttering always ──────────────────────
    const flapLayout: readonly [number, number, number, number][] = [
      // x, z, yaw, width scale
      [0, -BOX.d * 0.5 + 0.02, 0, BOX.w - 0.16],
      [0, BOX.d * 0.5 - 0.02, Math.PI, BOX.w - 0.16],
      [-BOX.w * 0.5 + 0.02, 0, Math.PI * 0.5, BOX.d - 0.2],
      [BOX.w * 0.5 - 0.02, 0, -Math.PI * 0.5, BOX.d - 0.2],
    ]
    for (let i = 0; i < 4; i++) {
      const [fx, fz, yaw, wide] = flapLayout[i]!
      const spring = this.flapSprings[i]!
      // Airflow pushes the leading flaps open and the trailing ones flat; the
      // side flaps mostly feel the corner.
      const facing = i === 0 ? 1 : i === 1 ? -0.55 : 0
      const lateral = (i === 2 ? -1 : i === 3 ? 1 : 0) * clamp(t.aLat, -30, 30) * 0.004
      const target = FLAP.rest
        + speedNorm * 0.42 * facing
        + lateral
        + sway(elapsed, 1.05 + i * 0.17, this.phaseFor(i)) * (0.05 + 0.13 * speedNorm) * (0.5 + amp * 0.5)
        - clamp(t.aLong, -60, 60) * 0.0016
      const angle = spring.step(dt, clamp(target, 0.25, 2.0))
      this.p.set(fx, RIM_Y - 0.03, fz)
      this.s.set(wide, 1, 1)
      // 'YXZ': yaw first, then the hinge tilt in the flap's own frame.
      this.flaps.set(i, this.p, -angle, yaw, 0, this.s)
    }
    this.flaps.flush()

    // ── the coat settles ───────────────────────────────────────────────────
    // Underdamped springs on measured acceleration: the coat swings out in a
    // corner, keeps going a moment after the corner ends, and rings down. When
    // the car parks, the ring-down IS the settle.
    const coatRoll = this.coatRoll.step(dt, clamp(t.aLat, -40, 40) * -0.0024
      + sway(elapsed, 0.19, 0.31) * 0.018 * amp)
    const coatPitch = this.coatPitch.step(dt, clamp(t.aLong, -80, 80) * 0.0016
      + sway(elapsed, 0.23, 0.77) * 0.014 * amp)
    this.coat.rotation.set(coatPitch, 0, coatRoll)
    this.collar.rotation.set(coatPitch * 0.7, 0, coatRoll * 0.7)
    this.collar.position.y = 1.4 + coatPitch * 0.02

    // ── occupants: bob, glance, blink, lean ────────────────────────────────
    for (let i = 0; i < this.occupants.length; i++) {
      const o = this.occupants[i]!
      // Glances arrive on a slow deterministic schedule; the SPRING is what
      // turns a schedule into a movement.
      const glanceSlot = Math.floor(elapsed / 2.6 + o.phase * 3)
      if (glanceSlot !== o.glanceSlot) {
        o.glanceSlot = glanceSlot
        // Wide enough that a glance sometimes brings the mask and an eye round
        // into view. From directly behind — which is where the chase camera
        // lives — a +/-30 degree glance is two brown blobs turning slightly.
        o.glanceYaw.target = (hash(glanceSlot * 13 + i) - 0.5) * 2.7
        o.glancePitch.target = (hash(glanceSlot * 29 + i * 5) - 0.5) * 0.42
      }
      // Blinks: 0.11s of closed eye. A spring on the lid means it is a blink,
      // not a dropped frame.
      const blinkPeriod = 3.1 + o.phase * 1.7
      const blinkSlot = Math.floor(elapsed / blinkPeriod + o.phase)
      const blinkT = elapsed - (blinkSlot - o.phase) * blinkPeriod
      const closing = blinkT < 0.11 ? 1 : 0
      const lid = o.lid.step(dt, closing)

      // Idle bob, plus a lean into whatever the car is doing. Two passengers
      // in one coat: they lean together, half a beat apart.
      const bobTarget = sway(elapsed, 0.44, o.phase) * 0.026 * amp
        - saturate(t.squash) * 0.06
      const bob = o.bob.step(dt, bobTarget)
      const leanX = clamp(t.aLat, -40, 40) * -0.0016
      const leanZ = clamp(t.aLat, -40, 40) * -0.0024
      const leanX2 = clamp(t.aLong, -80, 80) * -0.0009
      const yawG = o.glanceYaw.step(dt, o.glanceYaw.target) * (0.35 + 0.65 * t.idle)
      const pitchG = o.glancePitch.step(dt, o.glancePitch.target) * (0.35 + 0.65 * t.idle)

      const hx = HEAD.x * o.side + leanX
      const hy = HEAD.y + bob
      const hz = HEAD.z + leanX2 * 6
      const rx = pitchG + leanX2
      const ry = yawG
      const rz = leanZ

      this.p.set(hx, hy, hz)
      this.heads.set(i, this.p, rx, ry, rz)

      // Mask, muzzle, ears and eyes ride the head. Composing them by hand
      // rather than parenting keeps the whole occupant in four instanced
      // batches instead of ten meshes.
      const cy = Math.cos(ry)
      const sy = Math.sin(ry)
      const cx = Math.cos(rx)
      const sx2 = Math.sin(rx)
      const local = (lx: number, ly: number, lz: number): THREE.Vector3 => {
        // Ry * Rx applied to (lx, ly, lz), then offset to the head.
        const y1 = ly * cx - lz * sx2
        const z1 = ly * sx2 + lz * cx
        return this.p.set(hx + lx * cy + z1 * sy, hy + y1, hz - lx * sy + z1 * cy)
      }

      // A BAND, not a patch. v1 was a flattened lens on the front of the face
      // and the chase camera looks at the back of two heads: the mask survived
      // as one crescent on one cheek and was absent on the other head, so the
      // pair read as teddy bears. This wraps the sides and stops short of the
      // back of the skull, so the silhouette says raccoon from behind too.
      this.masks.set(i, local(0, 0.045, -0.055), rx, ry, rz, this.s.set(1.05, 0.42, 0.86))
      this.muzzles.set(i, local(0, -0.075, -0.245), rx, ry, rz, this.s.set(1, 0.85, 1.2))
      for (let e = 0; e < 2; e++) {
        const side = e === 0 ? -1 : 1
        this.ears.set(i * 2 + e, local(side * 0.185, 0.235, 0.01), rx, ry, rz,
          this.s.set(1, 1.15, 0.62))
        // The lid closes the eye by squashing it, which on a sphere with a
        // strong sky rim reads as a blink at any distance.
        this.eyes.set(i * 2 + e, local(side * 0.115, 0.05, -0.255), rx, ry, rz,
          this.s.set(1, 1 - lid * 0.9, 1))
      }
    }
    this.heads.flush()
    this.masks.flush()
    this.muzzles.flush()
    this.ears.flush()
    this.eyes.flush()

    // ── wheels: suspension travel, steer, spin ─────────────────────────────
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const w = vehicle.wheels[i]!
      this.p.set(w.anchor.x, -w.hubDrop, w.anchor.z)
      this.wheels.set(i, this.p, w.spin, w.steerAngle, 0)
      this.hubs.set(i, this.p, w.spin, w.steerAngle, 0)
      // From the chassis mount down to the hub. Tucked inboard of the tyre so
      // it never intersects the tread, and it does NOT steer with the wheel —
      // a trailing arm does not.
      this.p.set(w.anchor.x * 0.62, 0.16, w.anchor.z * 0.86)
      this.struts.set(i, this.p, 0, 0, 0, this.s.set(1, w.hubDrop + 0.16, 1))
    }
    this.wheels.flush()
    this.hubs.flush()
    this.struts.flush()
  }

  private phaseFor(i: number): number {
    return hash(i * 17 + 11)
  }
}
