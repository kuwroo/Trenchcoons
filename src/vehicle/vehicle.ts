// The vehicle. Custom raycast suspension over `Greybox.groundAt` — the height
// of the DRAWN triangle, not of the analytic field the mesh was sampled from —
// arcade handling, and every visible quantity a spring.
//
// THE SUSPENSION'S ACTUAL DEGREES OF FREEDOM, because M4 will tune the
// deformation stamp against `w.load` and the shape of this matters:
//   - ONE sprung heave DOF (`this.vy`) integrating the SUM of four wheel forces
//   - ONE spring each on the pitch and roll of the plane fit through the four
//     contact heights
//   - per-wheel compression derived geometrically from where each anchor lands
// Load transfer, one-wheel bumps and droop all read correctly. What does NOT
// exist is per-wheel oscillator state, so a single kerb strike cannot ring one
// corner independently of the other three.
//
// WHY NOT RAPIER (decided, not up for relitigation):
//   `heightAt` is analytic, so there is no collider to keep in sync and no
//   readback to wait on — a ray is four noise octaves, not a broadphase query.
//   The target is arcade (Mario Kart, and the Godot build), not simulation, and
//   every requirement in MILESTONES M3 — suspension travel, accel-driven roll
//   and pitch, squash and stretch, wheel slip, idle — is procedural anyway.
//   Rapier stays installed for prop collision later.
//
// THE HANDLING MODEL, and why lateral grip is a TARGET rather than a force.
//   The obvious model — coulomb lateral friction integrated as a force — has no
//   steady state. Heading rotation feeds lateral velocity at v*omega while
//   friction removes it at a constant rate, so any corner where v*omega exceeds
//   the friction cap spins out and never recovers; at 35 m/s that is every
//   corner unless the tyres are given 8g. Real tyres do not behave that way
//   either: slip angle settles where cornering force balances demand.
//   So the equilibrium is solved for directly. Lateral velocity springs toward
//   the slide the tyres would allow, which means:
//     - gentle cornering has essentially no slip
//     - hard cornering builds a real, visible drift
//     - releasing the wheel recovers instead of spinning
//     - it is unconditionally stable at any dt, which the shot harness needs
//
// Units are metres and seconds throughout.

import * as THREE from 'three/webgpu'
import { AngleSpring, Spring, clamp, damp, saturate, smoothstep } from '../core/spring'
import type { DriveInput } from './input'

/**
 * Feel constants carried over from the Godot build's `scenes/car.gd`
 * (ARCHITECTURE, "Migrating from the Godot build"). These four are the contract;
 * everything else below is new and tuned around them.
 */
export const FEEL = {
  maxSpeed: 35,
  accel: 60,
  friction: 8,
  turn: 4.5,
} as const

const GEOM = {
  /** ARCHITECTURE: "Car ~= 3.2m long". */
  wheelbase: 2.15,
  track: 1.66,
  wheelRadius: 0.4,
  /** Hub drop below the suspension anchor at rest. */
  rest: 0.34,
  /** Extra compression available above rest. */
  travel: 0.3,
  /** Extra extension available below rest, i.e. droop when airborne. */
  droop: 0.26,
} as const

/** Static suspension compression under gravity: g / (4 * springK). */
const STATIC_SAG = 26 / (4 * 59)

const TUNE = {
  /** Arcade gravity. 9.81 makes a light kart feel like it is falling in oil. */
  gravity: 26,
  /** Per-wheel spring rate, mass normalised. 4*k*c0 = gravity at c0 = 0.11m. */
  springK: 59,
  /** Per-wheel damper. Total 4c gives zeta ~0.7 against 4k. */
  damperC: 5.4,
  /** Reverse tops out well below forward. */
  reverseFraction: 0.4,
  brake: 74,
  /**
   * Ceiling on the lateral acceleration the steering is allowed to ASK for.
   *
   * The Godot curve `turn * speed/maxSpeed` is a constant-radius turn — 7.8 m
   * at every speed — which at 35 m/s demands 2.15 rad/s and 75 m/s^2, i.e.
   * 7.6 g. Everything downstream then saturates: body roll pinned at its
   * clamp, the inside wheels lifted off the ground, the slide angle at 24
   * degrees for the whole corner. Capping the DEMAND instead of the yaw rate
   * keeps the tight low-speed turn the constant-radius curve gives (and which
   * is most of the arcade feel) while letting the radius open up with speed,
   * which is what a fast corner actually looks like.
   *
   * 38 m/s^2 is still ~3.9 g. This is a cardboard box, not a Miata.
   */
  latDemandCap: 38,
  /** Absolute yaw-rate ceiling, so a low-speed full lock cannot pirouette. */
  yawRateMax: 2.4,
  /** Lateral acceleration the tyres hold before the slide angle opens up. */
  grip: 44,
  /** How far the slide opens once grip is exceeded, as a fraction of speed. */
  slideGain: 0.24,
  /** Speed scrubbed off by sliding sideways. Cornering has to cost something. */
  scrub: 0.34,
  /** Gravity fraction applied along the slope. */
  slopeGain: 0.85,
  /**
   * Extra deceleration below `staticSpeed` with no throttle applied.
   *
   * Without it "parked" is a lie on any real terrain: the greybox's slopes run
   * to 20 degrees, and pure rolling friction of 8 m/s^2 loses to a 9 m/s^2
   * slope component, so the idle car creeps downhill forever and the shot that
   * is supposed to prove the idle animation instead proves the car does not
   * hold a hill. This is a handbrake that engages itself.
   */
  staticGrip: 22,
  staticSpeed: 1.1,
  /**
   * Squash impulse per m/s of landing impact.
   *
   * This is a velocity kick on a 3.1 Hz spring, so the peak displacement it
   * produces is roughly kick / omega = kick / 19.5. At 0.03 a 14 m/s landing
   * — a 10 m drop, the biggest the greybox offers — peaked at 1.4% squash,
   * which is not "subtle", it is invisible. 0.22 puts the same landing at ~15%.
   */
  landingSquash: 0.22,
  /** Hard ceiling on squash, so a freak impact cannot fold the kart flat. */
  squashMax: 0.26,
  /**
   * Bump-stop stiffness multiplier over the last 20% of travel.
   *
   * Without it the position clamp is doing the work on every hard landing: a
   * 14 m/s impact into 0.30 m of travel spent nineteen frames pinned at full
   * compression while the clamp cancelled the momentum, which reads as the car
   * sinking into the ground rather than as a suspension absorbing a hit. A
   * progressive stop is also what real suspension does at the end of travel.
   *
   * Raised from 5 to 9 because it was still losing to steady-state load
   * transfer rather than to impacts: the outer front wheel sat pinned at
   * exactly the 0.30 clamp for ~30 consecutive frames mid-corner, which
   * photographs as a wheel jammed into the arch instead of one working at the
   * end of its travel. At 9 the stop wins before the clamp does.
   */
  bumpStop: 9,
  /**
   * How much of the flight-path angle the body takes on while airborne.
   *
   * The terrain plane fit is meaningless with all four wheels in the air, but
   * easing it to LEVEL is not right either: the greybox's jump is 67 frames
   * long and the kart flew every one of them dead flat, which is most of why
   * the airborne capture could not be told from a parked one. A vehicle in
   * flight points along its trajectory — nose up on the way out, nose down on
   * the way in. 0.6 of it, because this is arcade.
   */
  airPitch: 0.6,
} as const

/** Front-left, front-right, rear-left, rear-right. */
const WHEEL_ORDER = ['FL', 'FR', 'RL', 'RR'] as const
export type WheelName = (typeof WHEEL_ORDER)[number]

export interface WheelState {
  readonly name: WheelName
  /** Suspension anchor in chassis space. */
  readonly anchor: THREE.Vector3
  readonly front: boolean
  readonly driven: boolean
  /** Signed compression from rest, metres. >0 compressed, <0 drooping. */
  compression: number
  /** d(compression)/dt, clamped. The damper term reads this. */
  compressionRate: number
  /** Compression as 0..1 of the available travel. Feeds the deform stamp (M4). */
  load: number
  /** Hub offset below the anchor, metres. This is what the visual reads. */
  hubDrop: number
  contact: boolean
  /** Terrain height under the anchor. */
  groundY: number
  /** Rolling angle, radians, accumulated. */
  spin: number
  spinRate: number
  /** Longitudinal ground speed at this contact patch. */
  contactSpeed: number
  /** |spin surface speed - contact speed| / max(speed) — visible wheelspin. */
  slip: number
  steerAngle: number
}

export interface VehicleTelemetry {
  speed: number
  vLong: number
  vLat: number
  /** Sideways velocity as a fraction of total. Drives slip visuals + M4 stamp. */
  slipRatio: number
  aLong: number
  aLat: number
  yawRate: number
  pitch: number
  roll: number
  /** The plane fit through the four contacts, before the accel lean. Lets a
   *  capture tell body roll apart from a side-slope. */
  terrainPitch: number
  terrainRoll: number
  airborne: boolean
  contacts: number
  /** Squash spring, >0 squashed, <0 stretched. */
  squash: number
  /** 1 = parked and untouched, 0 = being driven. Crossfades the idle layer. */
  idle: number
  /** Seconds since the last landing. Used by the shot harness. */
  sinceLanding: number
  airtime: number
}

export type HeightField = (x: number, z: number) => number

const _anchor = new THREE.Vector3()
const _accel = new THREE.Vector3()

export class Vehicle {
  /** Chassis root: position + yaw/pitch/roll. Kart visuals parent to this. */
  readonly object = new THREE.Group()
  readonly wheels: WheelState[] = []
  readonly velocity = new THREE.Vector3()
  readonly forward = new THREE.Vector3(0, 0, -1)
  readonly right = new THREE.Vector3(1, 0, 0)

  yaw = 0
  /** Vertical velocity of the chassis, kept separate from the planar solve. */
  vy = 0

  readonly telemetry: VehicleTelemetry = {
    speed: 0, vLong: 0, vLat: 0, slipRatio: 0, aLong: 0, aLat: 0, yawRate: 0,
    pitch: 0, roll: 0, terrainPitch: 0, terrainRoll: 0,
    airborne: false, contacts: 4, squash: 0, idle: 1,
    sinceLanding: 99, airtime: 0,
  }

  // ── the springs. Nothing in here is allowed to move linearly. ─────────────
  /** Steering input itself is eased: a digital key is not a steering wheel. */
  private readonly steerIn = new Spring(0, 5.4, 1)
  /** Yaw rate, so the car takes a beat to rotate into a corner and out of it. */
  private readonly yawRateS = new Spring(0, 3.2, 0.88)
  /** Lateral velocity toward its grip-limited equilibrium. Builds the drift. */
  private readonly lateral = new Spring(0, 1.5, 0.9)
  // Terrain following and accel lean are SEPARATE springs, summed.
  //
  // One spring for both was wrong in a way a still frame makes obvious: the
  // accel lean wants to be soft and overshooting (1.4 Hz, zeta 0.55) but
  // terrain following is not a stylistic choice at all — the wheels are
  // physically on the ground, so the chassis has to track the plane through
  // them within a frame or two. Sharing the soft spring meant that four frames
  // after landing on a 30-degree slope the car was still level and the box was
  // buried to the rim in the hillside.
  /**
   * Terrain plane fit. Fast, near-critically damped, and its frequency RISES
   * with the size of the error.
   *
   * A fixed rate cannot serve both jobs. Small errors are bumps, and they want
   * a soft spring so the body floats over them. A large error means the chassis
   * is not on the plane its wheels are standing on — landing on a 24 degree
   * slope after a jump — and there a soft spring photographs as a car buried to
   * the rim in the hillside for a third of a second. Real suspension has the
   * same asymmetry: it is compliant over its travel and rigid past it.
   */
  private readonly terrainRollS = new Spring(0, 3.4, 0.95)
  private readonly terrainPitchS = new Spring(0, 3.4, 0.95)
  /** Body roll from lateral accel. zeta < 1: overshoots slightly, settles. */
  private readonly rollS = new Spring(0, 1.35, 0.55)
  /** Body pitch from longitudinal accel. Slightly stiffer than roll. */
  private readonly pitchS = new Spring(0, 1.55, 0.58)
  /** Landing squash. Rings twice and dies — "brief and subtle". */
  private readonly squashS = new Spring(0, 3.1, 0.42)
  /** Idle crossfade, so parking does not switch the idle layer on abruptly. */
  private readonly idleS = new Spring(1, 0.55, 1)
  /** Visual steer angle of the front wheels. */
  private readonly steerVis = new AngleSpring(0, 4.6, 0.9)

  private readonly prevVelocity = new THREE.Vector3()
  private wasAirborne = false
  /** Slope under the wheels, before the accel lean is added. */
  private terrainPitch = 0
  /** Low-passed body-frame acceleration, for the pose only. */
  private aLatSmooth = 0
  private aLongSmooth = 0
  /** Eased 0..1 "is there a contact patch". Gates everything that reads load. */
  private contactGate = 1

  constructor(private readonly heightAt: HeightField) {
    const { wheelbase, track } = GEOM
    for (const name of WHEEL_ORDER) {
      const front = name[0] === 'F'
      const left = name[1] === 'L'
      this.wheels.push({
        name,
        // -Z is forward (ARCHITECTURE conventions), so the front axle is at -z.
        anchor: new THREE.Vector3(
          (left ? -1 : 1) * track * 0.5, 0, (front ? -1 : 1) * wheelbase * 0.5,
        ),
        front,
        // Rear drive. It is what makes the throttle rotate the car.
        driven: !front,
        compression: 0, compressionRate: 0, load: 0, hubDrop: GEOM.rest, contact: true,
        groundY: 0, spin: 0, spinRate: 0, contactSpeed: 0, slip: 0, steerAngle: 0,
      })
    }
  }

  get geometry(): typeof GEOM { return GEOM }

  /** Place the car on the ground, at rest. Only legitimate at spawn. */
  spawn(x: number, z: number, yaw: number): void {
    this.yaw = yaw
    this.velocity.set(0, 0, 0)
    this.vy = 0
    this.object.rotation.order = 'YXZ'
    this.object.position.set(
      x, this.heightAt(x, z) + GEOM.rest + GEOM.wheelRadius - STATIC_SAG, z,
    )
    for (const s of [
      this.steerIn, this.yawRateS, this.lateral, this.rollS, this.pitchS,
      this.terrainRollS, this.terrainPitchS, this.squashS, this.steerVis,
    ]) s.reset(0)
    this.idleS.reset(1)
    this.aLatSmooth = 0
    this.aLongSmooth = 0
    this.contactGate = 1
    this.wasAirborne = false
    this.updateBasis()
    // One zero-length step so the wheels and pose are consistent before the
    // first frame renders — otherwise frame 0 of a capture shows the car
    // hanging at its spawn altitude with the suspension at rest.
    this.settle()
  }

  private updateBasis(): void {
    const s = Math.sin(this.yaw)
    const c = Math.cos(this.yaw)
    this.forward.set(-s, 0, -c)
    this.right.set(c, 0, -s)
  }

  /**
   * Resolve the static pose without advancing time.
   *
   * Two iterations: the wheel anchors depend on the chassis pose and the pose
   * depends on where the anchors land, so one pass leaves a car spawned on a
   * slope visibly floating on its uphill corner for the first frame — which on
   * a 64-frame warmup capture is a frame that gets photographed.
   */
  private settle(): void {
    const t = this.telemetry
    for (let i = 0; i < 3; i++) {
      this.applyPose()
      this.sampleWheels(0)
      let sum = 0
      for (const w of this.wheels) sum += w.groundY
      // Placed at the STATIC equilibrium, not at the unloaded rest length:
      // spawning a car 11cm high means every capture that lands inside the
      // first second of the run photographs a bounce nobody asked for.
      this.object.position.y = sum / 4 + GEOM.rest + GEOM.wheelRadius - STATIC_SAG
      const pose = this.terrainPose()
      this.terrainPitch = pose.pitch
      t.terrainPitch = pose.pitch
      t.terrainRoll = pose.roll
      this.pitchS.reset(0)
      this.rollS.reset(0)
      t.pitch = this.terrainPitchS.reset(pose.pitch).value
      t.roll = this.terrainRollS.reset(pose.roll).value
    }
    this.applyPose()
    this.sampleWheels(0)
  }

  /** Plane fit through the four contact heights. */
  private terrainPose(): { pitch: number; roll: number } {
    const [fl, fr, rl, rr] = this.wheels as [WheelState, WheelState, WheelState, WheelState]
    const front = (fl.groundY + fr.groundY) * 0.5
    const rear = (rl.groundY + rr.groundY) * 0.5
    const left = (fl.groundY + rl.groundY) * 0.5
    const rightH = (fr.groundY + rr.groundY) * 0.5
    // +pitch = nose up, +roll = right side up. See the Euler order note below.
    return {
      pitch: Math.atan2(front - rear, GEOM.wheelbase),
      roll: Math.atan2(rightH - left, GEOM.track),
    }
  }

  private applyPose(): void {
    // 'YXZ': R = Ry * Rx * Rz, so pitch and roll are applied in the yawed
    // frame. Any other order steers the pitch axis with the roll.
    this.object.rotation.set(this.telemetry.pitch, this.yaw, this.telemetry.roll)
  }

  /**
   * Raycast each wheel straight down and record the suspension state.
   * `dt` of 0 samples without integrating the wheel spin.
   */
  private sampleWheels(dt: number): void {
    const t = this.telemetry
    // Anchors are placed with the CURRENT sprung pose, which is what makes
    // nose-dive show up as front-wheel compression rather than as a body
    // rotation floating above unmoved wheels.
    this.object.updateMatrix()
    let contacts = 0
    for (const w of this.wheels) {
      _anchor.copy(w.anchor).applyMatrix4(this.object.matrix)
      w.groundY = this.heightAt(_anchor.x, _anchor.z)
      const gap = _anchor.y - w.groundY - GEOM.wheelRadius
      const prev = w.compression
      w.compression = clamp(GEOM.rest - gap, -GEOM.droop, GEOM.travel)
      w.contact = w.compression > -GEOM.droop + 1e-4
      if (w.contact) contacts++
      w.load = saturate(w.compression / GEOM.travel)
      w.hubDrop = GEOM.rest - w.compression
      w.compressionRate = dt > 0 ? clamp((w.compression - prev) / dt, -8, 8) : 0
      // Ground speed at this contact patch: v . f + yawRate * localX.
      w.contactSpeed = t.vLong + t.yawRate * w.anchor.x
    }
    t.contacts = contacts
    t.airborne = contacts === 0
  }

  update(dt: number, input: DriveInput): void {
    const t = this.telemetry
    if (!(dt > 0)) return
    const p = this.object.position

    // ── driver demand, eased ────────────────────────────────────────────────
    const steer = this.steerIn.step(dt, clamp(input.steer, -1, 1))
    const throttle = clamp(input.throttle, -1, 1)

    // ── body-frame velocity ─────────────────────────────────────────────────
    this.updateBasis()
    let vLong = this.velocity.dot(this.forward)
    let vLat = this.velocity.dot(this.right)

    // ── yaw. Turn rate scales with speed: no pirouettes at standstill. ───────
    // `turn * speed/maxSpeed` is the Godot build's curve — a constant-radius
    // turn — capped so top speed cannot spin the car on the spot.
    const speedAbs = Math.abs(vLong)
    const dirSign = clamp(vLong * 0.7, -1, 1)   // reverse inverts the steering
    const slideDamp = 1 - 0.4 * saturate(t.slipRatio * 1.6)
    const yawTarget = -steer * Math.min(
      FEEL.turn * (speedAbs / FEEL.maxSpeed),
      TUNE.latDemandCap / Math.max(speedAbs, 4),
      TUNE.yawRateMax,
    ) * dirSign * slideDamp
    const yawRate = this.yawRateS.step(dt, yawTarget)
    this.yaw += yawRate * dt
    this.updateBasis()
    t.yawRate = yawRate

    // ── longitudinal ────────────────────────────────────────────────────────
    const grounded = t.contacts > 0
    const traction = grounded ? t.contacts / 4 : 0
    if (throttle > 0) {
      vLong += throttle * FEEL.accel * traction * dt
    } else if (throttle < 0) {
      if (vLong > 0.4) vLong -= TUNE.brake * traction * dt
      else vLong -= FEEL.accel * 0.55 * traction * dt
    }
    // Rolling friction, never through zero.
    const rollFric = FEEL.friction * (grounded ? 1 : 0.18) * dt
    vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), rollFric)
    // Slope. Uses the TERRAIN pitch, not the sprung one — feeding the body's
    // own accel lean back into acceleration is a loop that self-oscillates.
    if (grounded) vLong -= TUNE.gravity * TUNE.slopeGain * Math.sin(this.terrainPitch) * dt
    // Handbrake-by-default at a standstill, so a parked car stays parked.
    if (Math.abs(throttle) < 0.05 && Math.abs(vLong) < TUNE.staticSpeed && grounded) {
      vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), TUNE.staticGrip * dt)
    }
    // Sliding sideways scrubs speed off.
    vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), Math.abs(vLat) * TUNE.scrub * dt)
    vLong = clamp(vLong, -FEEL.maxSpeed * TUNE.reverseFraction, FEEL.maxSpeed)

    // ── lateral: spring toward the grip-limited slide (see header) ───────────
    const demand = Math.abs(vLong * yawRate)
    const excess = saturate(demand / TUNE.grip)
    const slideTarget = grounded
      ? Math.sign(yawRate) * Math.abs(vLong) * TUNE.slideGain * excess ** 1.6
      // Airborne there is nothing to grip with, so whatever sideways velocity
      // the car left the ground with is simply kept.
      : vLat
    this.lateral.zeta = grounded ? 0.9 : 1.6
    vLat = this.lateral.step(dt, slideTarget)

    // ── recompose world velocity ────────────────────────────────────────────
    this.prevVelocity.copy(this.velocity)
    if (grounded) {
      this.velocity.copy(this.forward).multiplyScalar(vLong)
        .addScaledVector(this.right, vLat)
    } else {
      // AIRBORNE: BALLISTIC. Nothing is touching the ground, so nothing can
      // turn the velocity vector — steering still rotates the CHASSIS (that is
      // the visual spin, and it is how you line a landing up) but the
      // trajectory is fixed. Recomposing here, which is what the first pass
      // did, dragged the world velocity round with the yaw: a full-lock input
      // applied only while `contacts === 0` moved the landing point 14.1 m
      // sideways and swung the heading 56 degrees, off wheels that were all at
      // full droop.
      //
      // Air drag is the only horizontal force in flight and it acts along the
      // direction of TRAVEL, not along the chassis.
      const drag = FEEL.friction * 0.18 * dt
      const vh = Math.hypot(this.velocity.x, this.velocity.z)
      if (vh > drag) this.velocity.multiplyScalar((vh - drag) / vh)
      else this.velocity.set(0, 0, 0)
      // Re-express the unchanged vector in the NEW basis, so telemetry, wheel
      // spin and the touchdown handoff all read what the car is really doing.
      // Resetting the drift spring here means it starts the landing slide from
      // the real lateral velocity instead of fighting a discontinuity.
      vLong = this.velocity.dot(this.forward)
      vLat = this.velocity.dot(this.right)
      this.lateral.reset(vLat)
    }
    t.vLong = vLong
    t.vLat = vLat
    t.speed = Math.hypot(vLong, vLat)
    t.slipRatio = Math.abs(vLat) / Math.max(t.speed, 1.5)

    // Measured acceleration in the body frame. Centripetal falls out of this
    // for free, which is what body roll actually responds to.
    //
    // Scaled by contact, because every consumer of these two reads them as
    // TYRE LOAD: body roll and pitch, the coat springs, the occupant lean, the
    // camera roll and the FOV punch. With four wheels at full droop there is no
    // contact patch and therefore no load, and the first pass reported -37.9
    // m/s^2 — 3.9 g — mid-air, banking the body 12.6 degrees off a force
    // nothing was generating. Eased rather than switched, so a wheel skipping
    // over a crest does not step the pose.
    this.contactGate = damp(this.contactGate, grounded ? 1 : 0, 0.06, dt)
    _accel.copy(this.velocity).sub(this.prevVelocity).divideScalar(dt)
    t.aLong = clamp(_accel.dot(this.forward), -120, 120) * this.contactGate
    t.aLat = clamp(_accel.dot(this.right), -120, 120) * this.contactGate

    p.x += this.velocity.x * dt
    p.z += this.velocity.z * dt

    // ── suspension ──────────────────────────────────────────────────────────
    // Not four independent oscillators, and it matters for M4: there is ONE
    // sprung degree of freedom (`this.vy`, the chassis heave) driven by the SUM
    // of four wheel forces, plus a separate spring on the plane fit through the
    // four contact heights for pitch and roll. Per-wheel compression is then
    // derived geometrically from where each anchor ends up. So `w.load` is a
    // real, differing per-wheel number — load transfer and one-wheel bumps both
    // show — but a single wheel cannot ring at its own frequency.
    this.sampleWheels(dt)
    let force = -TUNE.gravity
    for (const w of this.wheels) {
      if (w.compression <= 0) continue
      // Progressive bump stop over the last fifth of travel.
      const over = w.compression - GEOM.travel * 0.8
      if (over > 0) {
        const f = over / (GEOM.travel * 0.2)
        force += TUNE.springK * TUNE.bumpStop * over * f
      }
      // BOTH terms push the body UP while the suspension is compressing: the
      // damper resists the change in compression, it does not resist the body.
      // Signing the damper against the compression rate instead makes the
      // system negatively damped, which reads as the car falling through the
      // world at faster than g — which is exactly what it did.
      force += TUNE.springK * w.compression + TUNE.damperC * w.compressionRate
    }
    this.vy += force * dt
    p.y += this.vy * dt
    // Captured BEFORE the floor clamp below, which zeroes it. A landing hard
    // enough to bottom the suspension inside one frame is exactly the landing
    // whose impact the squash is supposed to read, and taking the velocity
    // afterwards would report that one as the softest of all.
    const impactVy = this.vy

    // Hard floor. The springs alone cannot stop a fast drop into a steep face,
    // and tunnelling through the heightfield is unrecoverable.
    let lift = 0
    for (const w of this.wheels) {
      const maxDepth = w.compression - GEOM.travel
      if (maxDepth > lift) lift = maxDepth
    }
    // Belt and braces: keep the chassis origin clear of the ground under the
    // BODY as well as under the wheels. A wheel-only clamp is satisfied by a
    // car lying diagonally across a ridge with its middle underground, which
    // is exactly what a landing on a steep slope produces while the pose
    // springs are still catching up.
    const bellyClear = this.heightAt(p.x, p.z) + GEOM.wheelRadius * 0.45
    if (p.y < bellyClear) {
      lift = Math.max(lift, bellyClear - p.y)
    }
    if (lift > 0) {
      p.y += lift
      if (this.vy < 0) this.vy = 0
      this.sampleWheels(dt)
    }

    // ── landing: squash impulse, once, on the transition ─────────────────────
    const airborne = t.contacts === 0
    t.airtime = airborne ? t.airtime + dt : 0
    if (this.wasAirborne && !airborne) {
      const impact = Math.max(0, -impactVy)
      this.squashS.kick(impact * TUNE.landingSquash)
      t.sinceLanding = 0
    } else {
      t.sinceLanding += dt
    }
    this.wasAirborne = airborne

    // ── pose: terrain plane fit + accel-driven roll and pitch ───────────────
    const pose = this.terrainPose()
    this.terrainPitch = pose.pitch
    t.terrainPitch = pose.pitch
    t.terrainRoll = pose.roll
    const w = airborne ? 0 : 1
    // +aLat is acceleration toward the car's right, i.e. a right-hand corner,
    // which lifts the right side. +aLong is forward accel, which lifts the nose.
    // Gains in radians per m/s^2, tuned against what a STILL FRAME can read.
    // At 0.0035 a full-lock corner leaned 6.9 degrees, and the greybox's side
    // slopes run to 7-8 degrees — so the terrain plane fit routinely cancelled
    // the entire cornering lean and the car photographed upright in the middle
    // of a drift. 0.0055 gives ~11 degrees at the 34 m/s^2 the demand cap
    // actually delivers, which reads against any slope the world has, and is
    // the Capy-Castaway amount of exaggeration rather than the physical one.
    // The accel term is clamped SEPARATELY from the sum, so a hard corner on a
    // side-slope cannot saturate the pose and lose the terrain underneath it.
    //
    // Airborne (w = 0) the wheels are touching nothing, so the terrain fit is
    // meaningless and eases to level; the lean spring keeps whatever the launch
    // gave it and rings down.
    // Airborne, the body follows the FLIGHT PATH rather than easing to level.
    // See TUNE.airPitch.
    const flightPitch = Math.atan2(
      this.vy, Math.max(Math.hypot(this.velocity.x, this.velocity.z), 1),
    ) * TUNE.airPitch
    const rollGoal = clamp(pose.roll * w, -0.5, 0.5)
    const pitchGoal = clamp(w > 0 ? pose.pitch : flightPitch, -0.5, 0.5)
    this.terrainRollS.freq = 3.4 + 6 * saturate(Math.abs(rollGoal - this.terrainRollS.value) / 0.22)
    this.terrainPitchS.freq = 3.4 + 6 * saturate(Math.abs(pitchGoal - this.terrainPitchS.value) / 0.22)
    const groundRoll = this.terrainRollS.step(dt, rollGoal)
    const groundPitch = this.terrainPitchS.step(dt, pitchGoal)
    // The lean reads a SMOOTHED acceleration. Raw, it is dominated by the
    // one-frame velocity jump when a landing gives the tyres their grip back —
    // a 50 m/s^2 spike that has nothing to do with how hard the car is
    // cornering, and that leaned the body straight into the hill it had just
    // landed on.
    this.aLatSmooth = damp(this.aLatSmooth, t.aLat, 0.07, dt)
    this.aLongSmooth = damp(this.aLongSmooth, t.aLong, 0.07, dt)
    const leanRoll = this.rollS.step(dt, clamp(this.aLatSmooth * 0.0055, -0.24, 0.24))
    const leanPitch = this.pitchS.step(dt, clamp(this.aLongSmooth * 0.003, -0.22, 0.22))
    t.roll = clamp(groundRoll + leanRoll, -0.62, 0.62)
    t.pitch = clamp(groundPitch + leanPitch, -0.6, 0.6)
    this.applyPose()

    // Airborne stretch, landing squash. Both live on one spring, so a landing
    // during a stretch reads as one continuous motion.
    const stretch = airborne ? -0.055 * smoothstep(0.05, 0.45, t.airtime) : 0
    t.squash = clamp(this.squashS.step(dt, stretch), -0.08, TUNE.squashMax)

    // ── wheels: spin from contact velocity, plus visible slip ───────────────
    this.spinWheels(dt, throttle, vLong, vLat)
    const steerVis = this.steerVis.step(dt, steer * 0.52)
    for (const wheel of this.wheels) if (wheel.front) wheel.steerAngle = steerVis

    // ── idle weight ─────────────────────────────────────────────────────────
    const busy = saturate(t.speed / 2.2) + (input.active ? 1 : 0)
      + saturate(Math.abs(throttle)) + saturate(Math.abs(input.steer))
    t.idle = this.idleS.step(dt, saturate(1 - busy))
  }

  private spinWheels(dt: number, throttle: number, vLong: number, vLat: number): void {
    const t = this.telemetry
    const r = GEOM.wheelRadius
    // Wheelspin off the line, and a lateral component so a drifting wheel is
    // visibly turning faster than the ground under it.
    const launch = throttle > 0 ? throttle * (1 - saturate(Math.abs(vLong) / 7)) * 9 : 0
    const scrubSpin = Math.abs(vLat) * 0.45
    const locking = throttle < 0 && vLong > 3
    for (const w of this.wheels) {
      let surface = w.contactSpeed
      if (w.driven) surface += launch + scrubSpin
      else surface += scrubSpin * 0.3
      if (!w.contact) surface = w.spinRate * r + throttle * 6 * dt * 60
      if (locking && w.front) surface *= 0.22
      const target = surface / r
      // Wheel inertia. The lag IS the slip: the tyre surface and the ground
      // disagree for a moment, which is what reads as spinning up or locking.
      w.spinRate = damp(w.spinRate, target, 0.055, dt)
      w.spin += w.spinRate * dt
      w.slip = saturate(Math.abs(w.spinRate * r - w.contactSpeed) / Math.max(t.speed, 4))
    }
  }
}
