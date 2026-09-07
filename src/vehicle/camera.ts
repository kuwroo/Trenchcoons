// Chase camera. MILESTONES M3: "spring arm with velocity lookahead, FOV punch
// on acceleration, and lag that eases rather than snapping. The Godot build
// called `look_at` every physics frame with no smoothing — do not port that."
//
// What replaces it: the camera never looks at the car. It looks at a POINT that
// is itself spring-smoothed and pushed ahead of the car by its velocity, from a
// position that is a second spring. Two springs in series is what turns a rigid
// tripod into something with weight — and because the look point leads the car,
// the car sits off-centre into a corner instead of being nailed to the middle
// of the frame.
//
// THE SPRINGS RUN IN THE WORLD, WITH THE BIAS SOLVED OUT. Two passes got this
// wrong in opposite directions, and the fix is the third option neither tried.
//
// Pass 1 sprang in world space with no correction. A damped oscillator chasing
// a target moving at a constant v settles a constant distance BEHIND it —
// exactly 2*zeta*v/omega. At 35 m/s that is 2*0.85*35/(1.75*2pi) = 5.4 m for
// the position spring, so a rig nominally 8.0 m back measured 13.1 m back, and
// on a descent the nominal 3.1 m of camera height collapsed to 0.74 m. The
// tuning was then fighting a bias rather than a lag.
//
// Pass 2 sprang the OFFSET from the chassis instead. That removes the bias
// exactly — and removes the transient with it, which is the whole reason a
// spring is here. A pure TRANSLATION of the car leaves a chassis-relative
// offset completely unchanged, so the rig moves rigidly with the car and the
// springs never fire. Free fall and a hard launch are pure translations.
// Measured across a 21.8 m jump including ~1.2 s of fall at 14 m/s, `camY -
// carY` moved 3.100 -> 3.086 and the FOV moved 0.37 deg across the whole flight
// AND the touchdown: the kart's on-screen centroid shifted 17 px in a 450 px
// frame, all of it the body's own pitch. car-airborne was indistinguishable
// from a car parked on a hillside, which is the "teleports rigidly, no lag"
// failure MILESTONES M3 explicitly names, confined to one axis.
//
// So: spring in the WORLD, and feed the bias forward into the target instead of
// changing the frame the spring runs in.
//
//     target = anchor + velocity * (2 * zeta / (freq * TAU))
//
// That is the analytic settle offset, added back. At constant velocity the two
// cancel and the rig sits at exactly the nominal 8.0 m / 3.1 m — pass 2's one
// real achievement, kept. Under ACCELERATION they do not cancel: the residual
// is -a/omega^2, and every edge in the velocity (crest, launch, touchdown)
// steps the target while the spring still carries the old velocity, so the rig
// overshoots and rings down through metres. Lag where lag belongs, no bias.
//
// The vertical axis needed one more thing before any of that could reach it:
// `Vehicle.velocity` is recomposed each step from `forward` and `right`, so it
// is horizontal by construction and its y is always exactly 0. The chassis'
// real vertical speed now ships as `telemetry.vy` and is what this file feeds
// into both springs and into the aim point's lead.

import * as THREE from 'three/webgpu'
import { Spring, Spring3, clamp, damp, saturate } from '../core/spring'
import type { Vehicle } from './vehicle'
import type { HeightField } from './vehicle'

const RIG = {
  /** Arm length at a standstill, and how much longer it gets at top speed. */
  // Close, and it barely opens up with speed. The first pass sat 8.2 m back
  // and stretched to 11.3 at top speed, which put the kart at 12% of the frame
  // width — far enough that a 15 degree pitch change was two or three pixels
  // and the launch capture was indistinguishable from the idle one. A chase
  // camera that cannot show the animation is not doing its job.
  //
  // These are now the REALISED numbers: 6.5 m parked, 8.0 m at 35 m/s, both
  // measured off the live build. Before the offset-frame fix in the header they
  // were the nominal ones and the rig actually sat at 13.1 m.
  arm: 6.5,
  armSpeed: 1.5,
  height: 2.55,
  heightSpeed: 0.55,
  /** Seconds of velocity the look point leads the car by. */
  lookahead: 0.24,
  /**
   * Seconds of VERTICAL velocity the look point leads by.
   *
   * Shorter than the horizontal lead on purpose. The horizontal one is aiming
   * at where the car will be, which is a smooth quantity; `vy` also carries the
   * sprung heave, so at the full 0.24 s a kerb strike would throw the aim point
   * around. 0.16 s is enough that the frame drops with the car off a crest and
   * rises with it out of a compression, which is what the axis was missing
   * entirely: the look point used to be pinned at carY + 1.02 forever.
   */
  lookaheadVert: 0.16,
  /**
   * Height above the chassis origin that the camera aims at.
   *
   * 1.24, up from 1.02, and the reason is who the subject is. The occupants'
   * heads sit at chassis y 1.5 and the rig sits 2.55 m above the chassis, so
   * aiming below the box rim put the camera 15-25 degrees ABOVE the two faces
   * at every arm length — every capture in the set was the tops of two skulls,
   * and the mask, the eyes and the blink could not be photographed from the
   * game's own camera at all. Aiming between the box rim and the heads tips the
   * whole frame up by a couple of degrees: the faces read, and the horizon
   * comes back into shot, which also buys the car frames hue variety and lifts
   * their shadow luminance (the foreground was the darkest thing in them).
   */
  lookUp: 1.24,
  /** How far the arm swings from the heading toward the velocity when sliding.
   *  This is what makes a drift show the car's flank. */
  slideYaw: 0.45,
  fov: 58,
  fovPunch: 5.5,
  /**
   * FOV kick per m/s of landing impact, degrees per (m/s).
   *
   * The punch used to read `t.aLong` alone, which is contact-gated AND blind to
   * `vy`, so a 14 m/s touchdown produced a 0.05 deg FOV change — the impact
   * lives entirely on the vertical axis and none of it reached the frame. This
   * is the same impact velocity `squashS` is already kicked with, so the frame
   * punches on exactly the landings that squash the body. As a velocity kick on
   * a 1.3 Hz spring the peak is roughly kick/omega, i.e. ~5 deg at 14 m/s —
   * about the size of the standing-start punch, which is the right scale.
   */
  fovLandingKick: 3.0,
  /** Camera roll from lateral acceleration, radians. Subtle on purpose. */
  roll: 0.0009,
  /** Minimum clearance above the terrain. */
  clearance: 1.5,
  /**
   * Clearance for the LINE OF SIGHT, not just the camera position.
   *
   * Clamping only the camera's own position is not enough and the first capture
   * proved it: the car sat below a ridge crest, the camera cleared the ground it
   * was standing on, and the shot was four fifths dark hillside with two raccoon
   * ears visible over the top. The heightfield is analytic, so raising the rig
   * until the sightline clears is four extra samples, not a raycast budget.
   */
  sightClearance: 1.1,
  sightSamples: 5,
  /**
   * How far the terrain solve is allowed to raise the rig above its nominal
   * height, metres.
   *
   * Uncapped, "clear the sightline" turns into "climb the hill": on a steep
   * slope the ground behind the car rises faster than the arm is long, and the
   * solve answered with a 10 m lift — a top-down view of the kart, which is the
   * one angle a chase camera must never give. Capped, a steep uphill briefly
   * clips the car's lower half instead, which is the cheaper failure.
   */
  maxLift: 4.2,
  /**
   * Room the camera keeps around a scattered form, metres.
   *
   * The sightline solve only knows about the ground. In a gulley it answered
   * correctly and still put two hillsides and a rock instance through the near
   * plane across the left third of the frame, because a 9 m rock is not
   * terrain. `world.obstacles` already lists every scattered form big enough to
   * hide a car; the arm is pulled in until it is outside all of them.
   */
  obstaclePad: 1.6,
} as const

/** Just enough of `world.obstacles` to keep the camera out of the shrubbery. */
export interface CameraObstacle {
  x: number
  z: number
  r: number
}

/**
 * Framing overrides. CAPTURE ONLY — nothing in gameplay sets these.
 *
 * Pitch and squash are the entire subject of the launch and landing captures
 * and both are nearly invisible from dead astern, which is the only angle the
 * rig gives on its own. Rather than bend the gameplay camera to suit a
 * screenshot, `?camyaw=` swings the arm round the car and `?camarm=` shortens
 * it, so the shot harness can pick a 3/4-rear view of the same simulated pose.
 */
export interface ChaseFraming {
  /** Extra azimuth on the arm, radians. +ve swings the camera to the car's left. */
  yaw?: number | null
  /** Multiplier on the solved arm length. <1 pulls in. */
  arm?: number | null
  /**
   * Extra metres of camera HEIGHT, with the look point unchanged — so it
   * pitches the view down over the car rather than moving the subject.
   *
   * Added for the M7 water captures, and for the same reason `yaw` and `arm`
   * exist: the feature under test is invisible from the angle the rig gives on
   * its own. A foam wake is a pattern lying flat on the water, and from the
   * gameplay camera's 2.55 m it is seen at a grazing angle where a chain of
   * 4.6 m rings compresses into a line — measured, the longest unbroken run of
   * foam along a scanline was 0.63 of the box from astern against 0.37 in
   * `refs/water/shore-foam-wake.jpg`, which is a picture taken from above.
   * Lengthening the arm does not help; the rig's height is nearly constant, so
   * a longer arm only moves further away at the same grazing angle.
   *
   * NEGATIVE IS ALLOWED NOW, down to -2.4 m, and the reason is the mirror image
   * of the one above. The rig sits 2.55 m over the car, so pulling the arm in to
   * frame the OCCUPANTS' FACES only steepens the view — at `camarm=0.30` the
   * camera is 1.2 m away and 2.55 m up, which is a photograph of the tops of two
   * skulls. Every character detail on this vehicle is on the front of a head, and
   * before this there was no vantage in the harness that could see one. -2.4 is
   * the floor because the rig's own terrain solve keeps the camera above the
   * ground and a larger drop just gets clamped there instead, silently.
   */
  lift?: number | null
}

const TAU = Math.PI * 2

const _dir = new THREE.Vector3()
const _anchor = new THREE.Vector3()
const _look = new THREE.Vector3()
const _target = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _side = new THREE.Vector3()
/** Full 3D chassis velocity, including the y that `Vehicle.velocity` lacks. */
const _vel = new THREE.Vector3()
const _lead = new THREE.Vector3()

export class ChaseCamera {
  /**
   * Position spring, in WORLD metres, with the settle bias fed forward into its
   * target (see the header). Underdamped: the camera falls behind a change in
   * velocity, catches up past it, and settles.
   */
  private readonly pos = new Spring3(new THREE.Vector3(), 1.75, 0.85)
  /** Look-point spring, slower than the position one so aim trails framing. */
  private readonly aim = new Spring3(new THREE.Vector3(), 2.4, 0.95)
  /** FOV. Underdamped so a launch punches past and eases back. */
  private readonly fov = new Spring(RIG.fov, 1.3, 0.5)
  private readonly roll = new Spring(0, 1.15, 0.55)
  /** Arm length, so the camera pulls back into speed rather than jumping. */
  private readonly arm = new Spring(RIG.arm, 0.85, 1)
  /** Yaw blend toward the velocity vector while sliding. */
  private yawBlend = 0

  /** Capture-only framing offsets. See `ChaseFraming`. */
  private readonly frameYaw: number
  private readonly frameArm: number
  private readonly frameLift: number

  /**
   * Player orbit, layered on top of capture framing. Sticky — left-click drag
   * writes these and they stay until the next drag (or `orbitReset`). They are
   * NOT springs of their own: the position/aim springs already ease the rig to
   * wherever `resolve` points, so lagging the mouse itself would feel soft.
   */
  private userYaw = 0
  private userLift = 0

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly heightAt: HeightField,
    framing: ChaseFraming = {},
    private readonly obstacles: readonly CameraObstacle[] = [],
  ) {
    this.frameYaw = framing.yaw ?? 0
    this.frameArm = clamp(framing.arm ?? 1, 0.35, 3)
    this.frameLift = clamp(framing.lift ?? 0, -2.4, 60)
  }

  /**
   * Orbit the arm from a pointer delta, pixels. +dx swings the camera to the
   * car's left (same sign as `ChaseFraming.yaw`); +dy raises the camera.
   */
  orbitBy(dxPx: number, dyPx: number): void {
    this.userYaw += dxPx * 0.005
    // Keep the sum inside the same floor/ceiling `frameLift` uses, so a capture
    // that already lifted the rig cannot be dragged through the ground.
    this.userLift = clamp(
      this.userLift - dyPx * 0.012,
      -2.4 - this.frameLift,
      60 - this.frameLift,
    )
  }

  /** Snap the player orbit back to the default chase angle. */
  orbitReset(): void {
    this.userYaw = 0
    this.userLift = 0
  }

  /**
   * The analytic settle offset of a damped oscillator chasing a target moving
   * at constant velocity: 2*zeta/omega seconds of that velocity, behind. Added
   * to the target, it cancels — which is the whole trick in the header.
   */
  private static lead(spring: Spring3): number {
    return (2 * spring.zeta) / (spring.freq * TAU)
  }

  /** Snap the rig to the car with no lag. Spawn and teleport only. */
  reset(vehicle: Vehicle): void {
    this.resolve(vehicle, 0, _anchor, _look)
    this.pos.reset(_anchor)
    this.aim.reset(_look)
    this.fov.reset(RIG.fov)
    this.roll.reset(0)
    this.arm.reset(RIG.arm)
    this.apply()
  }

  private resolve(
    vehicle: Vehicle, dt: number, outPos: THREE.Vector3, outLook: THREE.Vector3,
  ): void {
    const t = vehicle.telemetry
    const car = vehicle.object.position
    const speedNorm = saturate(t.speed / 35)

    // Arm direction: mostly the car's heading. Blended toward the direction of
    // travel while sliding, and only while moving — at a standstill the
    // velocity vector is noise and would spin the camera.
    const blendTarget = t.slipRatio * RIG.slideYaw * saturate(t.speed / 6)
    this.yawBlend = damp(this.yawBlend, blendTarget, 0.25, dt)
    _dir.copy(vehicle.forward)
    if (t.speed > 0.5) {
      _side.copy(vehicle.velocity).normalize()
      _dir.lerp(_side, this.yawBlend).normalize()
    }
    // Capture framing + player orbit, both applied to the arm DIRECTION so the
    // terrain clearance solve below still runs against wherever the camera ends
    // up. Player yaw is sticky (see `orbitBy`); capture yaw is URL-only.
    const yaw = this.frameYaw + this.userYaw
    if (yaw !== 0) _dir.applyAxisAngle(_up, yaw)

    let arm = this.arm.step(dt, RIG.arm + RIG.armSpeed * speedNorm) * this.frameArm
    arm = Math.max(arm * 0.42, this.clearOfScatter(car, arm))

    // Velocity lookahead. The car leads the frame into a corner — and, since
    // `t.vy` exists, over a crest and down into a landing as well.
    outLook.copy(car)
      .addScaledVector(vehicle.velocity, RIG.lookahead)
      .addScaledVector(_up, RIG.lookUp)
    outLook.y += clamp(t.vy, -30, 30) * RIG.lookaheadVert

    // Two passes over the terrain solve. The first asks how high the rig would
    // have to sit to see over whatever is between it and the car; if that is
    // more than `maxLift`, the second pulls the arm IN instead — coming over
    // the crest rather than climbing above it, which is what a camera operator
    // would do and what keeps the kart from shrinking to nothing behind a hill.
    const targetY = car.y + RIG.lookUp
    const lift = this.frameLift + this.userLift
    let shrink = 1
    for (let pass = 0; pass < 2; pass++) {
      const a = arm * shrink
      outPos.copy(car)
        .addScaledVector(_dir, -a)
        .addScaledVector(_up, RIG.height + RIG.heightSpeed * speedNorm + lift)
      let need = this.heightAt(outPos.x, outPos.z) + RIG.clearance
      for (let i = 1; i <= RIG.sightSamples; i++) {
        const f = i / (RIG.sightSamples + 1)
        const hx = car.x + (outPos.x - car.x) * f
        const hz = car.z + (outPos.z - car.z) * f
        // Camera height that puts the sightline exactly this high at the
        // sample: lerp(targetY, camY, f) = terrain + clearance.
        const camY = targetY + (this.heightAt(hx, hz) + RIG.sightClearance - targetY) / f
        if (camY > need) need = camY
      }
      const over = need - (outPos.y + RIG.maxLift)
      if (pass === 0 && over > 0) {
        shrink = clamp(1 - over / 9, 0.42, 1)
        continue
      }
      if (outPos.y < need) outPos.y = Math.min(need, outPos.y + RIG.maxLift)
      break
    }
  }


  /**
   * Longest arm along `_dir` that keeps the camera outside every scattered
   * form. Solves the ray-circle entry point rather than testing the endpoint,
   * so an arm that grows past a bush cannot step through it in one frame.
   */
  private clearOfScatter(car: THREE.Vector3, arm: number): number {
    let limit = arm
    for (const o of this.obstacles) {
      const rr = o.r + RIG.obstaclePad
      const dx = o.x - car.x
      const dz = o.z - car.z
      // Distance along the BACKWARD arm direction. Anything the car is driving
      // toward is in front of the camera and irrelevant.
      const t = -(dx * _dir.x + dz * _dir.z)
      if (t <= 0 || t - rr > limit) continue
      const perpSq = dx * dx + dz * dz - t * t
      if (perpSq >= rr * rr) continue
      const entry = t - Math.sqrt(rr * rr - perpSq)
      if (entry < limit) limit = entry
    }
    return limit
  }

  private apply(): void {
    const cam = this.camera
    // Both springs hold world positions.
    cam.position.copy(this.pos.value)
    _target.copy(this.aim.value)
    // Roll by tilting the up-vector about the VIEW axis, then lookAt. Rotating
    // the camera after lookAt does not work — lookAt overwrites the quaternion
    // — and tilting up in world XY only rolls correctly when the view happens
    // to point down -Z.
    _dir.copy(_target).sub(cam.position)
    if (_dir.lengthSq() > 1e-8) {
      _dir.normalize()
      _side.copy(_dir).cross(_up)
      if (_side.lengthSq() > 1e-8) {
        _side.normalize()
        const r = this.roll.value
        cam.up.copy(_up).multiplyScalar(Math.cos(r)).addScaledVector(_side, Math.sin(r))
      }
    }
    cam.lookAt(_target)
    cam.up.set(0, 1, 0)
    if (Math.abs(cam.fov - this.fov.value) > 1e-4) {
      cam.fov = this.fov.value
      cam.updateProjectionMatrix()
    }
    cam.updateMatrixWorld()
  }

  update(dt: number, vehicle: Vehicle): void {
    if (!(dt > 0)) { this.apply(); return }
    const t = vehicle.telemetry
    // Terrain clearance is resolved inside `resolve`, BEFORE the spring, so a
    // ridge eases the camera up instead of snapping it.
    this.resolve(vehicle, dt, _anchor, _look)
    // The chassis velocity the springs lead by. `vehicle.velocity` is
    // horizontal by construction — see the header — so y comes from telemetry.
    _vel.set(vehicle.velocity.x, clamp(t.vy, -60, 60), vehicle.velocity.z)
    // World-space springs with the settle bias fed forward. At constant
    // velocity the two cancel and the framing is nominal; every change in
    // velocity leaves a real transient behind.
    this.pos.step(dt, _lead.copy(_anchor).addScaledVector(_vel, ChaseCamera.lead(this.pos)))
    this.aim.step(dt, _lead.copy(_look).addScaledVector(_vel, ChaseCamera.lead(this.aim)))

    // FOV punch tracks longitudinal acceleration, not speed: it should hit on
    // the launch and relax at a steady 35 m/s. The landing arrives as an
    // impulse instead, because it is one — see `fovLandingKick`.
    const punch = saturate(clamp(t.aLong, 0, 80) / 34)
    if (t.landingImpact > 0) this.fov.kick(t.landingImpact * RIG.fovLandingKick)
    this.fov.step(dt, RIG.fov + RIG.fovPunch * punch)
    this.roll.step(dt, clamp(t.aLat, -40, 40) * -RIG.roll)
    this.apply()
  }
}
