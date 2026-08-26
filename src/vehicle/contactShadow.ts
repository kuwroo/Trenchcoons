// Contact shadow. The one thing that puts the kart IN the scene instead of on
// top of it.
//
// The sun cascades already give the kart a cast shadow, but a cast shadow at a
// 30-degree sun elevation is a detached slab several metres up-sun: the ground
// directly under the chassis and between the wheels stays fully lit, and every
// M3 capture read as a kart pasted onto the grass. It is also why the airborne
// frame could not be told from the parked one at 1:1 — nothing underneath the
// car moved away when the car left the ground.
//
// What this is: a ground-conforming patch under the car carrying a soft
// occlusion field — one lobe per wheel contact plus a wider one under the
// chassis — that WIDENS and FADES with height above the ground. Five metres of
// air reads as five metres because the blobs have spread and gone.
//
// Three things it deliberately is not:
//   - not black. ART_BIBLE: "shadows are coloured and lifted, tinted toward the
//     sky hue, never neutral, never near-black. Deleting this rule deletes the
//     entire look." So it is a MULTIPLY toward a cool sky tint, which cannot
//     crush whatever is under it and which cools as it darkens.
//   - not a caster. It sits on layer 1; the sun cascades render the scene with
//     an override material through cameras that only see layer 0, so a flat
//     dark disc lying on the ground cannot cast a second offset shadow of
//     itself. `main.ts` enables layer 1 on the view camera.
//   - not linear in anything. Height, spread and strength all ease.
//
// One mesh, one draw call, no per-instance attributes: the patch is a grid
// whose vertices are pushed onto `groundAt` each frame, so it follows the drawn
// triangles exactly rather than floating over a slope.

import * as THREE from 'three/webgpu'
import {
  attribute, float, positionWorld, saturate as saturateNode, uniform, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { saturate } from '../core/spring'
import type { HeightField } from './vehicle'
import type { Vehicle } from './vehicle'

/** Layer the sun cascades do not see. Kept here so main.ts can enable it. */
export const NO_CAST_LAYER = 1

const PATCH = {
  /** Half-extent of the patch, metres. Must cover the kart at any yaw plus
   *  the widest a blob gets before it fades out — a lobe clipped by the patch
   *  edge draws a straight line across the grass, which is worse than no
   *  shadow at all. Wheel lobes reach 1.35 m off-centre and 2.7 m of radius at
   *  the fade height, so 4.6 has margin. */
  half: 4.6,
  /** Vertices per side. 0.31 m spacing — about seven across a wheel lobe. */
  segments: 30,
  /** Clearance above the drawn ground. Big enough to beat the kink where the
   *  patch crosses a quad edge, small enough to be invisible at 8 m. */
  lift: 0.09,
} as const

const LOBE = {
  /** Wheel lobe radius on the ground, and how fast it spreads with height. */
  wheelR: 1.1,
  wheelSpread: 0.62,
  wheelStrength: 0.9,
  /**
   * Chassis lobe. Wider, softer, and the one that actually shows.
   *
   * Sized against the picture: at 1.5 m the darkening reached the frame at a
   * max of 25/255 in an A/B against the same build with the patch removed,
   * because the only ground the chase camera can SEE is the strip between and
   * behind the wheels, and the wheels themselves hide their own contact
   * patches. The lobe has to be wide enough that its shoulder covers what the
   * kart does not.
   */
  bodyR: 2.2,
  bodySpread: 0.5,
  bodyStrength: 0.85,
  /**
   * A tight, dark CORE at each contact patch, under the wide wheel lobe.
   *
   * The wide lobes are correct and were still losing: measured across
   * car-airborne at y=845, the meadow's own brush pattern swings luminance
   * 80->142 over 25 px, while a 1.1 m lobe with a 0.62 spread lays its
   * gradient down over 200+ px. A signal that shallow is under the surface's
   * own noise floor no matter how dark its centre is, so both jump frames
   * still read as a kart pasted onto a hillside at 1:1.
   *
   * What a contact patch actually looks like is a small, hard, dark spot the
   * size of the tyre — high contrast over a short distance, which is the one
   * thing that beats a noise floor. It also fades over 0.9 m rather than 2.6,
   * so it is the element that says TOUCHING: the moment the wheels leave the
   * ground the cores are gone and only the soft lobes remain, which is exactly
   * the difference between car-landing and car-airborne.
   */
  coreR: 0.5,
  coreSpread: 1.6,
  coreStrength: 0.95,
  coreFade: 0.9,
  /** Height, metres, over which a lobe fades to nothing. */
  fade: 2.6,
} as const

/**
 * Multiply tint at full strength: darkens ~40% and cools.
 *
 * Bounded from BOTH sides by measurement, which is the only way to set it.
 * Too light and it does nothing: at (0.63, 0.69, 0.82) — what "between #6FB03F
 * and the #3F7A3E grass shadow stop" works out to on paper — an A/B against the
 * same build with the patch removed moved a max of 25/255, invisible at 1:1
 * against a hyper-saturated meadow. Too dark and it breaks the rule it exists
 * to serve: at (0.42, 0.50, 0.66) the patch also multiplies ground that is
 * ALREADY in the sun's shadow, and car-launch fell to shadowLuma 0.290 against
 * the shadow gate's 0.299 floor — crushed, which ART_BIBLE forbids outright.
 * This sits between them. The ratio is close to the grassland shadow stop's own
 * ratio to its base (0.57, 0.69, 0.98), rotated further toward the sky.
 */
const TINT = new THREE.Color(0.56, 0.64, 0.79)

/** Four soft wheel lobes plus one chassis lobe, in the vertex attribute. */
const LOBE_COUNT = 5

const _p = new THREE.Vector3()

export class ContactShadow {
  readonly mesh: THREE.Mesh
  private readonly geo: THREE.BufferGeometry
  private readonly pos: THREE.BufferAttribute
  private readonly shade: THREE.BufferAttribute
  private readonly n: number
  /**
   * Per lobe: world x, world z, height above ground, kind.
   * Kind 0 = soft wheel lobe, 1 = chassis lobe. The tight contact cores are
   * NOT in here — see `coreU`.
   */
  private readonly lobes = new Float32Array(LOBE_COUNT * 4)
  /**
   * The four contact cores, as fragment-stage uniforms: (world x, world z,
   * height above ground, unused).
   *
   * They cannot ride the vertex attribute the soft lobes use. The patch grid is
   * 0.31 m and a core is 0.5 m across, so interpolating it between vertices
   * would draw a three-vertex-wide hexagon and the hard edge that is the whole
   * point of the core would come out as the grid's own triangulation. Raising
   * the grid resolution enough to carry it would quadruple a per-frame CPU loop
   * that already costs 961 `heightAt` calls. In the fragment it is exact, it is
   * four uniforms, and it costs four distance computations per covered pixel.
   */
  private readonly coreU = [0, 1, 2, 3].map(() => uniform(new THREE.Vector3()))

  constructor(private readonly heightAt: HeightField) {
    const n = PATCH.segments + 1
    this.n = n
    const geo = new THREE.PlaneGeometry(
      PATCH.half * 2, PATCH.half * 2, PATCH.segments, PATCH.segments,
    )
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    pos.setUsage(THREE.DynamicDrawUsage)
    const shade = new THREE.BufferAttribute(new Float32Array(n * n), 1)
    shade.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aShade', shade)
    // The patch is repositioned in world space every frame, so a bounding
    // sphere computed once is meaningless and culling it would pop.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    // The generic must be pinned: `attribute('aShade', 'float')` widens
    // TNodeType to `string` and the node then satisfies no numeric overload.
    const s = attribute<'float'>('aShade', 'float')
    const material = new THREE.MeshBasicNodeMaterial()
    // MultiplyBlending is dst * src, so src must be WHITE where there is no
    // shadow. That also makes the effect impossible to crush: it can only ever
    // scale what the painterly material already put on the ground.
    //
    // Written as `1 - s * (1 - tint)` rather than as `mix(white, tint, s)`
    // because `mix()` silently read the attribute as 0 and compiled to a
    // constant white — the patch rendered, took the depth test, and multiplied
    // everything by exactly 1. `vec3(s, s, s)` of the same node is correct, so
    // this is the attribute node reaching `mix`'s interpolant slot, not the
    // attribute. Broadcasting it by hand first is unambiguous.
    // The four contact cores, evaluated per fragment. Same soft-union algebra
    // as the vertex field — 1 - prod(1 - lobe) — so a wheel sitting on top of
    // the chassis lobe darkens it instead of replacing it.
    let clear: Node<'float'> = float(1).sub(s)
    for (const u of this.coreU) {
      const h = u.z
      const r = float(LOBE.coreR).add(h.mul(LOBE.coreSpread))
      const lift = saturateNode(h.div(LOBE.coreFade)).oneMinus()
      const d = vec2(positionWorld.x.sub(u.x), positionWorld.z.sub(u.y)).length()
      const t = saturateNode(d.div(r))
      const a = t.mul(t).oneMinus().pow(2).mul(LOBE.coreStrength).mul(lift)
      clear = clear.mul(a.oneMinus())
    }
    const fade = vec3(1, 1, 1).mul(clear.oneMinus())
    material.colorNode = vec4(
      vec3(1, 1, 1).sub(fade.mul(vec3(1 - TINT.r, 1 - TINT.g, 1 - TINT.b))), 1,
    )
    material.blending = THREE.MultiplyBlending
    // Not optional: the WebGPU backend only implements MultiplyBlending on the
    // premultiplied path (WebGPUPipelineUtils, `src*Dst + dst*(1-srcAlpha)`)
    // and errors to the console otherwise. With srcAlpha 1 that reduces to a
    // plain src*dst, which is what the header describes.
    material.premultipliedAlpha = true
    material.transparent = true
    material.depthWrite = false
    material.toneMapped = false
    material.side = THREE.FrontSide

    this.geo = geo
    this.pos = pos
    this.shade = shade
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.name = 'kart-contact-shadow'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    // Invisible to the sun cascades — see the header.
    this.mesh.layers.set(NO_CAST_LAYER)
  }

  /**
   * `dt` is not needed: every quantity here is a pure function of the pose, and
   * the pose is already the output of springs. Adding a spring on top of a
   * sprung input would only add a second lag to the one thing in the frame that
   * must stay welded to the wheels.
   */
  update(vehicle: Vehicle): void {
    const car = vehicle.object.position
    const wheelR = vehicle.geometry.wheelRadius

    // Lobe 0..3: the four soft wheel lobes. 4..7: a tight core at the same
    // four contact patches. 8: the chassis.
    vehicle.object.updateMatrix()
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i]!
      _p.copy(w.anchor).applyMatrix4(vehicle.object.matrix)
      // The hub hangs `hubDrop` below the anchor; the tyre bottom is one radius
      // below that. `groundY` is the drawn ground under the same anchor.
      const height = Math.max(0, _p.y - w.hubDrop - wheelR - w.groundY)
      this.lobes[i * 4 + 0] = _p.x
      this.lobes[i * 4 + 1] = _p.z
      this.lobes[i * 4 + 2] = height
      this.lobes[i * 4 + 3] = 0
      this.coreU[i]!.value.set(_p.x, _p.z, height)
    }
    this.lobes[16] = car.x
    this.lobes[17] = car.z
    this.lobes[18] = Math.max(0, car.y - wheelR - this.heightAt(car.x, car.z))
    this.lobes[19] = 1

    const n = this.n
    const step = (PATCH.half * 2) / PATCH.segments
    const x0 = car.x - PATCH.half
    const z0 = car.z - PATCH.half
    const posArr = this.pos.array as Float32Array
    const shadeArr = this.shade.array as Float32Array

    for (let j = 0; j < n; j++) {
      const z = z0 + j * step
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step
        const v = j * n + i
        posArr[v * 3 + 0] = x
        posArr[v * 3 + 1] = this.heightAt(x, z) + PATCH.lift
        posArr[v * 3 + 2] = z

        // Soft union of the nine lobes: 1 - prod(1 - lobe). Adding them
        // instead would double up under the axles and clip flat.
        let clear = 1
        for (let k = 0; k < LOBE_COUNT; k++) {
          const h = this.lobes[k * 4 + 2]!
          const body = this.lobes[k * 4 + 3]! > 0.5
          const fade = 1 - saturate(h / LOBE.fade)
          if (fade <= 0) continue
          const r = body
            ? LOBE.bodyR + h * LOBE.bodySpread
            : LOBE.wheelR + h * LOBE.wheelSpread
          const dx = x - this.lobes[k * 4 + 0]!
          const dz = z - this.lobes[k * 4 + 1]!
          const d = Math.hypot(dx, dz)
          if (d >= r) continue
          const core = body ? LOBE.bodyStrength : LOBE.wheelStrength
          // (1 - t^2)^2, not a hermite. Both are C1 at the rim, but the hermite
          // spends most of its range near zero and put 83% of the occlusion
          // under parts of the kart the camera cannot see; this one carries a
          // real shoulder out to the edge.
          const t = d / r
          const a = core * fade * (1 - t * t) ** 2
          clear *= 1 - a
        }
        shadeArr[v] = 1 - clear
      }
    }
    this.pos.needsUpdate = true
    this.shade.needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
