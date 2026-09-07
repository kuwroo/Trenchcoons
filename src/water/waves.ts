// The wave field. One definition, evaluated on the GPU for the surface and on
// the CPU for the wheels.
//
// The two evaluations HAVE to agree or the car floats above its own water, so
// they live in one file and share one wave table. The GPU version also returns
// the analytic normal; the CPU version does not need it (the vehicle fits a
// plane through four wheel contacts and gets its roll from that).
//
// SMALL WAVES ON PURPOSE. Both references are nearly flat water — what reads as
// surface in them is the ripple/caustic NETWORK, not displacement, and
// `lake-cartoon-cells.jpg` has no vertical relief at all. Three sines at a
// combined 0.24 m is enough to break the horizon line, catch a glint and rock
// the car, and small enough that the depth ladder's bands stay where the
// bathymetry put them. Anything bigger reads as an ocean sim, which is the
// opposite of the brief.
//
// Deep-water dispersion (omega = sqrt(g k)) rather than a free speed per wave,
// taken from ~/procedural-sea: it is one line and it is what stops the short
// waves crawling visibly slower than the long ones.

import { cos, float, pow, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

interface WaveSpec {
  /** Unit direction in world XZ. */
  dx: number
  dz: number
  /** Wavelength as a fraction of `waveScale`. */
  len: number
  /** Amplitude weight; normalised so the three sum to 1. */
  amp: number
  /** Phase-speed multiplier on top of the dispersion relation. */
  speed: number
}

/** Three crossing waves. Directions are irrational-ish so they never beat. */
const WAVES: readonly WaveSpec[] = [
  { dx: 0.863, dz: 0.505, len: 1.0, amp: 1.0, speed: 1.0 },
  { dx: -0.416, dz: 0.909, len: 0.54, amp: 0.44, speed: 1.22 },
  { dx: 0.339, dz: -0.941, len: 0.27, amp: 0.2, speed: 1.55 },
]

const AMP_TOTAL = WAVES.reduce((s, w) => s + w.amp, 0)
const G = 9.81
const TAU = Math.PI * 2

export interface WaveSample {
  /** Metres above the still water line. */
  height: Node<'float'>
  /** Analytic surface normal, world space, y-up. */
  normal: Node<'vec3'>
  /** Gerstner horizontal pinch, world XZ. Applied to the vertex, not the read. */
  offset: Node<'vec2'>
}

/** GPU evaluation. `amp`, `scale`, `speed` and `chop` are the def's params. */
export function waveField(
  worldXZ: Node<'vec2'>,
  time: Node<'float'>,
  amp: Node<'float'>,
  scale: Node<'float'>,
  speed: Node<'float'>,
  chop: Node<'float'>,
): WaveSample {
  let height: Node<'float'> = float(0)
  let dhdx: Node<'float'> = float(0)
  let dhdz: Node<'float'> = float(0)
  let offset: Node<'vec2'> = vec2(0, 0)
  for (const w of WAVES) {
    const dir = vec2(w.dx, w.dz)
    // k = 2 pi / wavelength, and the wavelength is a def param, so k is a node.
    const k = float(TAU / w.len).div(scale.max(1))
    const a = amp.mul(w.amp / AMP_TOTAL)
    const omega = k.mul(G).sqrt().mul(w.speed).mul(speed)
    const phase = worldXZ.dot(dir).mul(k).sub(time.mul(omega))
    const s = sin(phase)
    const c = cos(phase)
    height = height.add(a.mul(s))
    dhdx = dhdx.add(a.mul(k).mul(w.dx).mul(c))
    dhdz = dhdz.add(a.mul(k).mul(w.dz).mul(c))
    // Gerstner pinch: crests narrow, troughs broaden. Scaled by 1/k so the
    // horizontal excursion stays a fixed fraction of the wavelength.
    offset = offset.add(dir.mul(a.mul(chop).mul(c).negate()))
  }
  return {
    height,
    normal: vec3(dhdx.negate(), 1, dhdz.negate()).normalize(),
    offset,
  }
}

/**
 * CPU evaluation of the SAME field. Metres above the still line.
 *
 * The chop offset is deliberately not applied here. It moves the surface
 * horizontally by at most `waveAmp * waveChop` — 13 cm at the shipped params —
 * and the vehicle's contact query is a height lookup at a fixed XZ, so folding
 * it in would mean inverting a displacement map to answer "which vertex landed
 * over this point". 13 cm of horizontal phase error on a 27 m wave is a
 * millimetre of height.
 */
export function waveHeightAt(
  x: number, z: number, time: number,
  amp: number, scale: number, speed: number,
): number {
  let h = 0
  const s = Math.max(1, scale)
  for (const w of WAVES) {
    const k = (TAU / w.len) / s
    const a = amp * (w.amp / AMP_TOTAL)
    const omega = Math.sqrt(k * G) * w.speed * speed
    h += a * Math.sin((x * w.dx + z * w.dz) * k - time * omega)
  }
  return h
}

/**
 * THE SWASH — waves washing up the beach and draining back.
 *
 * This is not a separate painted effect. It is a periodic RISE IN THE WATER
 * LEVEL that only acts in the shallows, and everything else follows from that:
 * the sheet floods a strip of sand and drains off it, the depth ladder's
 * shallow bands slide up and down the beach with it, and the surf line — which
 * is authored in horizontal metres from the waterline — rides the moving edge
 * without knowing the swash exists. Painting a moving foam band on a static
 * waterline was the alternative and it cannot flood anything.
 *
 * `reachDepth` is where it stops: the lift fades out by the time the water is
 * this deep, so open sea is untouched and only the beach breathes.
 *
 * The pulse is deliberately NOT a plain sine. Real swash runs up fast and
 * drains slowly, so the 0..1 sine is raised to a power below 1, which holds it
 * near the top of its travel and hurries it through the bottom. The along-shore
 * phase term stops the whole coast from surging as one line, which is the thing
 * that would read as a rising tide rather than as waves.
 *
 * THAT PHASE TERM HAS TO BE MUCH SLOWER THAN IT LOOKS. It has to turn over well
 * outside the VIEW, not merely slowly: at 0.023 cycles/m the phase repeated every
 * 43 m, and at 0.0042 every 240 m, and both are shorter than the stretch of shore
 * one frame contains. In each case one end of the beach ran up while the other
 * drained, the spatial average never changed, and the waterline rippled in place
 * instead of advancing — measured, wet coverage moved 0.0026 across half a cycle
 * with the lift at 1.3 m, LESS than the ordinary wave field supplies on its own.
 * At 0.0008 the wavelength is about 1250 m, several times the visible shore, so a
 * bay surges together and the wash reads as one wave arriving.
 */
export function swashLift(
  worldXZ: Node<'vec2'>,
  depth: Node<'float'>,
  time: Node<'float'>,
  amp: Node<'float'>,
  reachDepth: Node<'float'>,
  rate: Node<'float'>,
): Node<'float'> {
  const mask = smoothstep(reachDepth, float(0), depth)
  const along = worldXZ.x.mul(0.0008).add(worldXZ.y.mul(0.0006))
  const ph = time.mul(rate).add(along).mul(TAU)
  const shaped = pow(sin(ph).mul(0.5).add(0.5).max(0.0001), float(0.55))
  return amp.mul(mask).mul(shaped)
}

/** CPU evaluation of the SAME swash, for the vehicle's floating query. */
export function swashLiftAt(
  x: number, z: number, depth: number, time: number,
  amp: number, reachDepth: number, rate: number,
): number {
  if (depth >= reachDepth) return 0
  const e = Math.max(0, Math.min(1, depth / Math.max(1e-4, reachDepth)))
  // smoothstep(reachDepth, 0, depth) — 1 at the waterline, 0 at reachDepth.
  const mask = 1 - (e * e * (3 - 2 * e))
  const along = x * 0.0008 + z * 0.0006
  const ph = (time * rate + along) * TAU
  const shaped = Math.pow(Math.max(0.0001, Math.sin(ph) * 0.5 + 0.5), 0.55)
  return amp * mask * shaped
}
