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
// THE SPRINGS RUN IN THE CAR'S FRAME, NOT THE WORLD'S. This is the difference
// between "lag" and "error", and the first pass got it wrong. A damped
// oscillator chasing a target that moves at a constant v settles at a constant
// offset BEHIND it — exactly 2*zeta*v/omega. At 35 m/s that is 2*0.85*35/(1.75
// *2pi) = 5.4 m for the position spring, so a rig nominally 8.0 m back
// measured 13.1 m back, and on a descent the nominal 3.1 m of camera height
// collapsed to 0.74 m. The tuning above was then fighting a bias, not a lag:
// the shipped camera sat FURTHER back at speed than the 11.3 m first pass that
// was rejected for making a 15-degree pitch change two pixels tall.
//
// Springing the OFFSET (target minus car position) removes the bias exactly and
// keeps everything the springs are for. A car at constant velocity has a
// constant offset, so the spring is at rest and the framing is the nominal one;
// the offset only changes when the car accelerates, turns, slides, or the
// terrain solve lifts the rig — and those are precisely the moments that should
// ease rather than snap.

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
  /** Height above the chassis origin that the camera aims at. */
  lookUp: 1.02,
  /** How far the arm swings from the heading toward the velocity when sliding.
   *  This is what makes a drift show the car's flank. */
  slideYaw: 0.45,
  fov: 58,
  fovPunch: 5.5,
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
}

const _dir = new THREE.Vector3()
const _anchor = new THREE.Vector3()
const _look = new THREE.Vector3()
const _target = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _side = new THREE.Vector3()

export class ChaseCamera {
  /**
   * Position spring, in CHASSIS-RELATIVE metres (see the header). Underdamped:
   * the camera lags a change in the offset, catches up, and settles.
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
  /** Chassis position the two offset springs are measured from, this frame. */
  private readonly origin = new THREE.Vector3()

  /** Capture-only framing offsets. See `ChaseFraming`. */
  private readonly frameYaw: number
  private readonly frameArm: number

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly heightAt: HeightField,
    framing: ChaseFraming = {},
    private readonly obstacles: readonly CameraObstacle[] = [],
  ) {
    this.frameYaw = framing.yaw ?? 0
    this.frameArm = clamp(framing.arm ?? 1, 0.35, 3)
  }

  /** Snap the rig to the car with no lag. Spawn and teleport only. */
  reset(vehicle: Vehicle): void {
    this.origin.copy(vehicle.object.position)
    this.resolve(vehicle, 0, _anchor, _look)
    this.pos.reset(_anchor.sub(this.origin))
    this.aim.reset(_look.sub(this.origin))
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
    // Capture-only azimuth swing. Applied to the arm DIRECTION, so the terrain
    // clearance solve below still runs against wherever the camera ends up.
    if (this.frameYaw !== 0) _dir.applyAxisAngle(_up, this.frameYaw)

    let arm = this.arm.step(dt, RIG.arm + RIG.armSpeed * speedNorm) * this.frameArm
    arm = Math.max(arm * 0.42, this.clearOfScatter(car, arm))

    // Velocity lookahead. The car leads the frame into a corner.
    outLook.copy(car)
      .addScaledVector(vehicle.velocity, RIG.lookahead)
      .addScaledVector(_up, RIG.lookUp)

    // Two passes over the terrain solve. The first asks how high the rig would
    // have to sit to see over whatever is between it and the car; if that is
    // more than `maxLift`, the second pulls the arm IN instead — coming over
    // the crest rather than climbing above it, which is what a camera operator
    // would do and what keeps the kart from shrinking to nothing behind a hill.
    const targetY = car.y + RIG.lookUp
    let shrink = 1
    for (let pass = 0; pass < 2; pass++) {
      const a = arm * shrink
      outPos.copy(car)
        .addScaledVector(_dir, -a)
        .addScaledVector(_up, RIG.height + RIG.heightSpeed * speedNorm)
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
    // Both springs hold offsets from the chassis; the world pose is rebuilt here.
    cam.position.copy(this.origin).add(this.pos.value)
    _target.copy(this.origin).add(this.aim.value)
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
    this.origin.copy(vehicle.object.position)
    this.resolve(vehicle, dt, _anchor, _look)
    // Into the chassis frame, so the springs carry no steady-state error and
    // respond only to the offset CHANGING. See the header.
    this.pos.step(dt, _anchor.sub(this.origin))
    this.aim.step(dt, _look.sub(this.origin))

    // FOV punch tracks longitudinal acceleration, not speed: it should hit on
    // the launch and relax at a steady 35 m/s.
    const punch = saturate(clamp(t.aLong, 0, 80) / 34)
    this.fov.step(dt, RIG.fov + RIG.fovPunch * punch)
    this.roll.step(dt, clamp(t.aLat, -40, 40) * -RIG.roll)
    this.apply()
  }
}
