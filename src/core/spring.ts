// The one spring/easing utility. CLAUDE.md "Motion rule": nothing in this game
// moves linearly — camera, suspension, body roll, wheel spin, UI and idle all
// route through here.
//
// Why an ANALYTIC integrator rather than the usual
// `v += (target - x) * k * dt; x += v * dt`:
//
//   1. Determinism. The screenshot harness is only meaningful if frame N is
//      byte-identical between runs (M0). An explicit integrator is stable only
//      for dt below ~2/omega, so a stiff spring silently explodes at a
//      different dt — and the shot harness runs a FIXED dt while the game runs
//      a variable one. Solving the ODE closed-form makes the two agree, and
//      makes a 100ms hitch produce a settled spring instead of a divergence.
//   2. The parameters mean something. `freq` is the undamped natural frequency
//      in Hz and `zeta` is the damping ratio, so "overshoot slightly and
//      settle" (MILESTONES M3) is `zeta = 0.6`, not a pair of numbers found by
//      trial and error.
//
// A spring's target is held constant across the step. At 60Hz with targets that
// are themselves smooth this is well inside the noise.

import * as THREE from 'three/webgpu'

const TAU = Math.PI * 2

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const saturate = (v: number): number => clamp(v, 0, 1)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Hermite ease, 0..1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

/** Quintic ease with zero second derivative at both ends. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

/** Overshoots once on the way out. For UI pops and landing recoil. */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const c = overshoot + 1
  return 1 + c * (t - 1) ** 3 + overshoot * (t - 1) ** 2
}

/**
 * Frame-rate-independent exponential approach. `halfLife` is the time to close
 * half the remaining distance, in seconds — so it reads as a feel value and is
 * identical at 30, 60 and 144 Hz. Use this where no overshoot is wanted at all
 * (wheel spin-up, grade following); use `Spring` where the motion should have
 * weight.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (!(dt > 0)) return current
  if (halfLife <= 0) return target
  return target + (current - target) * Math.exp((-Math.LN2 * dt) / halfLife)
}

/** Shortest signed delta between two angles, radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

export const dampAngle = (current: number, target: number, halfLife: number, dt: number): number =>
  damp(current, current + angleDelta(current, target), halfLife, dt)

/**
 * Damped harmonic oscillator, solved exactly per step.
 *
 * `freq`  — undamped natural frequency in Hz. How fast it wants to move.
 * `zeta`  — damping ratio. 1 = critically damped (fastest settle, no
 *           overshoot), <1 overshoots, >1 crawls in.
 */
export class Spring {
  value: number
  velocity = 0
  target: number
  freq: number
  zeta: number

  constructor(value = 0, freq = 4, zeta = 1) {
    this.value = value
    this.target = value
    this.freq = freq
    this.zeta = zeta
  }

  /** Jump to a value, killing all motion. Only legitimate at spawn/teleport. */
  reset(value: number): this {
    this.value = value
    this.target = value
    this.velocity = 0
    return this
  }

  /** Add velocity without moving the value — an impulse. Landing recoil. */
  kick(dv: number): this {
    this.velocity += dv
    return this
  }

  step(dt: number, target = this.target): number {
    this.target = target
    // dt <= 0 must be a hard no-op: the shot harness FREEZES the clock once
    // `__ready` resolves and keeps rendering, and any motion after that point
    // would break the byte-identical contract.
    if (!(dt > 0)) return this.value
    const w = this.freq * TAU
    if (w <= 0) return this.value
    const z = this.zeta
    const y0 = this.value - target
    const v0 = this.velocity
    let y: number
    let v: number
    if (z < 1 - 1e-4) {
      // Underdamped: rings down. This is the "overshoot slightly" case.
      const wd = w * Math.sqrt(1 - z * z)
      const e = Math.exp(-z * w * dt)
      const c = Math.cos(wd * dt)
      const s = Math.sin(wd * dt)
      const a = y0
      const b = (v0 + z * w * y0) / wd
      y = e * (a * c + b * s)
      v = e * ((wd * b - z * w * a) * c - (z * w * b + wd * a) * s)
    } else if (z <= 1 + 1e-4) {
      // Critically damped: (A + Bt)e^-wt.
      const e = Math.exp(-w * dt)
      const a = y0
      const b = v0 + w * y0
      y = (a + b * dt) * e
      v = (b - w * (a + b * dt)) * e
    } else {
      // Overdamped: two real exponentials.
      const rt = w * Math.sqrt(z * z - 1)
      const r1 = -z * w + rt
      const r2 = -z * w - rt
      const c1 = (v0 - r2 * y0) / (r1 - r2)
      const c2 = y0 - c1
      const e1 = Math.exp(r1 * dt)
      const e2 = Math.exp(r2 * dt)
      y = c1 * e1 + c2 * e2
      v = c1 * r1 * e1 + c2 * r2 * e2
    }
    this.value = target + y
    this.velocity = v
    return this.value
  }
}

/** Angular spring. Targets are unwrapped to the nearest equivalent angle. */
export class AngleSpring extends Spring {
  override step(dt: number, target = this.target): number {
    return super.step(dt, this.value + angleDelta(this.value, target))
  }
}

/** Three independent springs sharing one set of coefficients. */
export class Spring3 {
  readonly value = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  readonly target = new THREE.Vector3()
  private readonly sx: Spring
  private readonly sy: Spring
  private readonly sz: Spring

  constructor(value = new THREE.Vector3(), freq = 3, zeta = 1) {
    this.sx = new Spring(value.x, freq, zeta)
    this.sy = new Spring(value.y, freq, zeta)
    this.sz = new Spring(value.z, freq, zeta)
    this.value.copy(value)
    this.target.copy(value)
  }

  set freq(f: number) { this.sx.freq = f; this.sy.freq = f; this.sz.freq = f }
  get freq(): number { return this.sx.freq }
  set zeta(z: number) { this.sx.zeta = z; this.sy.zeta = z; this.sz.zeta = z }
  get zeta(): number { return this.sx.zeta }

  reset(v: THREE.Vector3): this {
    this.sx.reset(v.x); this.sy.reset(v.y); this.sz.reset(v.z)
    this.value.copy(v)
    this.target.copy(v)
    this.velocity.set(0, 0, 0)
    return this
  }

  step(dt: number, target: THREE.Vector3): THREE.Vector3 {
    this.target.copy(target)
    this.value.set(
      this.sx.step(dt, target.x),
      this.sy.step(dt, target.y),
      this.sz.step(dt, target.z),
    )
    this.velocity.set(this.sx.velocity, this.sy.velocity, this.sz.velocity)
    return this.value
  }
}

/**
 * Sum of two incommensurable sines, in 0..1.
 *
 * The idle layer needs motion that never repeats visibly and never sits still.
 * A single sine has an obvious period and, worse, two dead frames per cycle
 * where the thing it drives is momentarily static. Two sines whose ratio is
 * irrational have neither.
 */
export function breathe(t: number, hz: number, phase = 0): number {
  const a = Math.sin((t * hz + phase) * TAU)
  const b = Math.sin((t * hz * 0.4142 + phase * 1.7) * TAU)
  return (a * 0.72 + b * 0.28) * 0.5 + 0.5
}

/** Same, signed -1..1. */
export const sway = (t: number, hz: number, phase = 0): number =>
  breathe(t, hz, phase) * 2 - 1
