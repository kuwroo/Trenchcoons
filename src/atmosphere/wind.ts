// The one global wind field. Render-graph pass 2.
//
// CLAUDE.md invariant: "All vegetation samples the one global wind field. No
// per-asset wobble." The pass slot has existed since M0 and nothing had filled
// it, so the grass this round adds would otherwise have arrived with a private
// sine — which is exactly the failure the invariant names. A field that every
// consumer shares is what makes a gust read as a gust: the same travelling
// front crosses the grass, the shrubs and (when it lands) the trenchcoat, in
// that order, because they are at different distances along the wind vector.
//
// ANALYTIC, NOT AN RT. ARCHITECTURE budgets a small render target for this, and
// a texture is the right answer once the field carries vehicle wake and gust
// fronts with history. It carries neither yet, and an analytic field costs no
// pass, no readback and no memory while giving the one property that actually
// matters here — global coherence. The TSL and the CPU evaluators below are the
// same function, so a shader and a spring cannot disagree about the weather.

import * as THREE from 'three/webgpu'
import { cos, dot, float, sin, uniform, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Metres between crests of the primary gust front. */
const GUST_WAVELENGTH = 34
/** Metres per second the front travels. */
const GUST_SPEED = 7.5
/** Second, shorter front, at an angle to the first. Breaks up the corduroy. */
const RIPPLE_WAVELENGTH = 7.3
const RIPPLE_SPEED = 4.1

export interface WindOptions {
  /** Heading in radians. 0 = blowing toward +x. */
  heading?: number
  /** Overall strength, 0..2. 1 is a steady breeze. */
  strength?: number
}

export class WindField {
  /** Seconds. Advanced by the render graph, frozen in shot mode with the clock. */
  readonly timeNode = uniform(0)
  readonly dirNode = uniform(new THREE.Vector2(1, 0))
  readonly strengthNode = uniform(1)

  private t = 0
  private heading: number
  private strength: number

  constructor(options: WindOptions = {}) {
    this.heading = options.heading ?? 0.72
    this.strength = options.strength ?? 1
    this.dirNode.value.set(Math.cos(this.heading), Math.sin(this.heading))
    this.strengthNode.value = this.strength
  }

  /** Render-graph pass 2. */
  update(dt: number): void {
    if (!(dt > 0)) return
    this.t += dt
    this.timeNode.value = this.t
  }

  /**
   * Horizontal sway in metres at a world position, for a vegetation TIP.
   *
   * @param worldXZ Where the plant is rooted. Vegetation must pass its ROOT,
   *   not the vertex being displaced, or a tall blade shears instead of bending
   *   and the whole clump reads as jelly.
   * @param weight 0 at the root, 1 at the tip. Callers usually pass
   *   `positionLocal.y / height`, cubed a little so the bend is a curve.
   */
  sway(worldXZ: Node<'vec2'>, weight: Node<'float'>): Node<'vec3'> {
    const d = this.dirNode
    const along = dot(worldXZ, d)
    const across = worldXZ.x.mul(d.y.negate()).add(worldXZ.y.mul(d.x))
    const phase = along.mul(float(Math.PI * 2 / GUST_WAVELENGTH))
      .sub(this.timeNode.mul(float(Math.PI * 2 * GUST_SPEED / GUST_WAVELENGTH)))
    const ripplePhase = across.mul(float(Math.PI * 2 / RIPPLE_WAVELENGTH))
      .add(along.mul(float(Math.PI * 2 / (RIPPLE_WAVELENGTH * 2.7))))
      .sub(this.timeNode.mul(float(Math.PI * 2 * RIPPLE_SPEED / RIPPLE_WAVELENGTH)))
    // A gust is never negative — grass leans downwind and springs back, it does
    // not lean upwind. `0.5 * (1 + sin)` biased so there is always some motion.
    const gust = sin(phase).mul(0.5).add(0.62)
      .add(sin(ripplePhase).mul(0.22))
      .mul(this.strengthNode)
    const amount = gust.mul(weight)
    return vec3(d.x.mul(amount), cos(phase).mul(amount).mul(-0.12), d.y.mul(amount))
  }

  /** CPU twin of `sway`, for props animated on the simulation side. */
  sampleAt(x: number, z: number): { x: number; z: number } {
    const dx = Math.cos(this.heading)
    const dz = Math.sin(this.heading)
    const along = x * dx + z * dz
    const across = -x * dz + z * dx
    const phase = along * (Math.PI * 2 / GUST_WAVELENGTH)
      - this.t * (Math.PI * 2 * GUST_SPEED / GUST_WAVELENGTH)
    const ripple = across * (Math.PI * 2 / RIPPLE_WAVELENGTH)
      + along * (Math.PI * 2 / (RIPPLE_WAVELENGTH * 2.7))
      - this.t * (Math.PI * 2 * RIPPLE_SPEED / RIPPLE_WAVELENGTH)
    const gust = (Math.sin(phase) * 0.5 + 0.62 + Math.sin(ripple) * 0.22) * this.strength
    return { x: dx * gust, z: dz * gust }
  }

  /** For the debug HUD. */
  get seconds(): number { return this.t }
}
