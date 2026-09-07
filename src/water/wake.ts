// The wake field — white foam the car leaves on the water.
//
// One toroidal render target, written by the car and read by the water
// material. The same idea as src/deform/field.ts and deliberately a tenth of
// the code, because foam has none of the three properties that make the
// deformation field complicated:
//
//   NO TIER LADDER. A tyre mark in mud is "essentially permanent until rain",
//   so the deform field needs a coarse committed tier to remember ground you
//   left. Foam lives six seconds. There is nothing to remember.
//
//   NO RECENTRING, AND NO BAND REFILL. This is the load-bearing simplification
//   and it is an arithmetic argument, asserted below: a texel's alias sits
//   exactly `SPAN` metres away, and at `FOAM_LIFE` seconds of life the fastest
//   the car can be is `SPAN / FOAM_LIFE` m/s before it could outrun its own
//   ghost and drive into it. 256 m over 6 s is 43 m/s against a measured top
//   speed of 35 on water, so a wrapped alias has always decayed to nothing
//   before the player can reach it. The window therefore never has to move.
//
//   NO CPU MIRROR. Nothing in the physics reads the foam.
//
// WHAT IT STORES. R = foam, 0..1. A = freshness, which the material uses to
// break the mark into lace as it ages (see `wakeLace`); a wake that merely
// faded uniformly would read as a grey smear rather than as the chain of
// dissolving rings in refs/water/shore-foam-wake.jpg.
//
// TWO STAMP SHAPES, and that is the whole reason the reference reads as a wake
// rather than as a stripe. The picture shows a broad churn immediately behind
// the object AND a chain of overlapping circles trailing away from it, so the
// stamp material carries both: a capsule along each wheel's path this frame,
// and an annulus pulsed every `RING_STRIDE` metres of travel.

import * as THREE from 'three/webgpu'
import {
  abs, attribute, float, length, max, mix, mod, mx_noise_float, normalize,
  positionGeometry, saturate, smoothstep, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Texels across the field. */
export const WAKE_RES = 2048
/**
 * Metres across the field. 0.167 m per texel.
 *
 * TIGHTENED FROM 512 m TO BUY LINE WIDTH, which is the resolution half of "the
 * rings do not show". A ring's drawn line can never be thinner than a texel,
 * and at 0.33 m per texel the thinnest representable line on a 4.2 m ring was
 * 16% of its own diameter — a fat doughnut, where the reference's are nearer
 * 10%. Halving the span halves the line. The price is trail LENGTH, through the
 * no-recentre argument below, and 210 m of wake at top speed is more than any
 * camera in the game can see at once.
 */
export const WAKE_SPAN = 256
/** Seconds for a full-strength mark to reach zero. */
export const FOAM_LIFE = 6
/**
 * Seconds of life for the CONTACT channel (G), against `FOAM_LIFE` for the wake
 * proper (R). Deliberately short.
 *
 * The wake and the water breaking against a moving hull are the same colour and
 * nothing else about them is alike, and one decay rate could not express both:
 * a mark strong enough to SEE has to be authored above the material's lace
 * threshold, and with a six-second life a continuously-issued mark that strong
 * sweeps into a slab within a second — measured, `wakeShare` 0.15 -> 0.44 and
 * the stroke 0.0064 -> 0.0167 against the reference's 0.0047. Dropping it below
 * the threshold instead makes it invisible. That is not a tuning problem, it is
 * one rate being asked to do two jobs.
 *
 * At 1.1 s a continuous stamp CANNOT accumulate into a slab: at 35 m/s it
 * reaches about 38 m behind the car and is gone, so the froth stays a halo on
 * the hull instead of a painted stripe down the bay.
 */
export const CONTACT_LIFE = 1.1

// The no-recentre argument, kept executable so it cannot rot silently. A car
// faster than this could drive into the toroidal alias of its own wake.
const MAX_SAFE_SPEED = WAKE_SPAN / FOAM_LIFE
if (MAX_SAFE_SPEED < 40) {
  throw new Error(
    `wake field: SPAN ${WAKE_SPAN} m / LIFE ${FOAM_LIFE} s = ${MAX_SAFE_SPEED} m/s `
    + 'is below the vehicle top speed, so the field needs recentring after all',
  )
}

/**
 * Metres of travel between ring pulses.
 *
 * SET AGAINST THE RING DIAMETER, not picked. The reference's rings OVERLAP —
 * each new one cuts into the last — so the stride wants to be well under a
 * diameter: at `RING_RADIUS` 2.1 and a 1.35x speed cap that is 2.2 m against a
 * 5.7 m diameter.
 *
 * Tightened from 3.0 once the stroke got thin enough to afford it. The reference
 * chain crosses a scanline 14 times against our 3.2-4.8, and more rings only
 * help if each one is a LINE rather than a tube — at a fat stroke a shorter
 * stride merges them back into a slab, which is what happened at 1.6 m.
 *
 * It went 1.6 -> 5.0 -> 2.2, and the middle value is the instructive one. At
 * 1.6 m with the old 3.5 m radius the rings were four deep in each other and
 * the trail measured 2.08 separate foam runs per scanline against the
 * reference chain's 13.96, i.e. a slab. Raising the stride to 5 m separated
 * them and the count went DOWN to 1.75, because the thing welding the trail
 * together was never the ring spacing — it was the continuous hull capsule
 * underneath, at a width that reached the rings' inner edge. Two knobs, one
 * symptom, and the wrong one moved first.
 */
// 1.65. Spacing the pulses out to 3.2 — roughly tangent, which is how the
// reference's chain looks — was tried and is much worse: `wakeShare` halved to
// 0.065, `hull` went to 1.000 and the enclosed pockets to ZERO, because isolated
// hoops have no envelope to be porous inside. The reference's 121 pockets are not
// gaps BETWEEN rings, they are holes in a dense overlapping mass.
export const RING_STRIDE = 1.65

/** Instances the stamp pass can draw in one frame. */
const STAMP_MAX = 48
/** Same number, exported so callers can stop pushing before it is exceeded. */
export const STAMP_BUDGET = STAMP_MAX
/** The 3x3 toroidal wrap neighbourhood, as src/deform/field.ts documents. */
const WRAP = 9
const STAMP_INSTANCES = STAMP_MAX * WRAP

/** One mark to write this frame. */
export interface FoamStamp {
  /** Start of the segment, world XZ. */
  ax: number
  az: number
  /** End of the segment. Equal to the start for a ring. */
  bx: number
  bz: number
  /** Metres. Capsule half-width, or ring radius. */
  radius: number
  /** 0..1. */
  amount: number
  /** 0 = capsule (solid), 1 = annulus (hollow). */
  ring: number
  /**
   * Ring stroke half-width, as a fraction of `radius`. Per stamp, because the
   * two things that use a ring want opposite weights: a wake pulse is a light
   * hoop and a rock's collar is a thick wash.
   *
   * MEASURED against `refs/water/lake-cartoon-cells.jpg`, whose rings hold
   * stroke/diameter at 0.091-0.104 on every mark. At a single shared 0.10 the
   * rock collars rendered at 0.027 — a 4 px line round a 165 px ellipse — while
   * other foam in the same build sat at 0.27-0.31, a 12x spread where the
   * references hold one weight. The material's threshold erodes the authored
   * band by roughly 3.7x, so the number here runs well above the target.
   */
  band: number
  /**
   * 0..1 written to the CONTACT channel (G) instead of the wake channel (R).
   * A stamp may write either or both; `amount` drives R and this drives G.
   * See `CONTACT_LIFE` for why they are separate channels rather than one.
   */
  contact: number
}

function dynAttr(count: number, size: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size)
  a.setUsage(THREE.DynamicDrawUsage)
  return a
}

export class WakeField {
  readonly rt: THREE.RenderTarget

  private readonly quad = new THREE.QuadMesh()
  /** OrthographicCamera, not Camera — see the note in src/deform/field.ts. */
  private readonly flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly scratch: THREE.RenderTarget

  private readonly stampScene = new THREE.Scene()
  private readonly stampSeg = dynAttr(STAMP_INSTANCES, 4)
  private readonly stampPar = dynAttr(STAMP_INSTANCES, 4)
  /** x = contact amount into G. y spare. */
  private readonly stampAux = dynAttr(STAMP_INSTANCES, 2)
  private readonly stampGeo: THREE.InstancedBufferGeometry

  private readonly decayMaterial = new THREE.NodeMaterial()
  private readonly decaySrc: ReturnType<typeof texture>
  private readonly decayDt = uniform(0)
  private readonly clearMaterial = new THREE.NodeMaterial()

  private cleared = false
  private debt = 0
  private frame = 0

  constructor() {
    this.rt = makeTarget('water-wake')
    this.scratch = makeTarget('water-wake-scratch')
    this.decaySrc = texture(this.rt.texture)

    // ── the stamp ───────────────────────────────────────────────────────────
    const seg = attribute<'vec4'>('iSeg', 'vec4')
    const par = attribute<'vec4'>('iParams', 'vec4')
    const aux = attribute<'vec2'>('iAux', 'vec2')
    const a = seg.xy
    const b = seg.zw
    // Never narrower than a texel of this field, for the reason field.ts
    // spells out at length: a sub-texel quad misses every pixel centre and the
    // pass silently writes nothing.
    const radius = max(par.x, float(WAKE_SPAN / WAKE_RES * 0.75))
    const pad = radius.mul(2.1).add(0.3)
    const d = b.sub(a)
    const len = length(d).max(1e-4)
    // THE BASIS HAS TO SURVIVE A ZERO-LENGTH SEGMENT, and until it did the ring
    // pulses never drew a single pixel.
    //
    // A ring is stamped as a point (`ax == bx`, `az == bz`), so `d` is exactly
    // (0, 0); `d.div(len)` is then (0, 0) rather than a unit vector, `perp` is
    // (0, 0) with it, and every corner of the quad evaluates to the segment
    // midpoint — a degenerate triangle with no area, which rasterises nothing.
    // The deformation field this pass is modelled on never hits the case
    // because a wheel trace always has length, so the pattern came across
    // silently broken. Measured before the fix: `__trenchWater.scan` showed the
    // trail as a uniform 3.6 m stripe no matter what `RING_RADIUS` was set to,
    // including 3.5 m, which is what proved the ring instances were absent
    // rather than merely subtle.
    //
    // The nudge is 1e-4 m against segments of order 0.5 m, i.e. a direction
    // error under a hundredth of a degree on a real segment, and an arbitrary
    // but valid +x basis on a point — which is all a radially symmetric annulus
    // needs.
    const dir = normalize(d.add(vec2(1e-4, 0)))
    const perp = vec2(dir.y.negate(), dir.x)
    const corner = positionGeometry.xy
    const world = a.add(b).mul(0.5)
      .add(dir.mul(corner.x.mul(len.mul(0.5).add(pad))))
      .add(perp.mul(corner.y.mul(pad)))

    const stampMat = new THREE.NodeMaterial()
    const wrapIndex = attribute<'float'>('iWrapIndex', 'float')
    const wrapX = mod(wrapIndex, 3).sub(1)
    const wrapZ = wrapIndex.div(3).floor().sub(1)
    const cell = a.div(WAKE_SPAN).floor().mul(WAKE_SPAN)
    const ndc = world.sub(cell).div(WAKE_SPAN).mul(2).sub(1)
      .add(vec2(wrapX, wrapZ).mul(2))
    // Y NEGATED and DoubleSide, both for the reasons src/deform/field.ts
    // documents: under WebGPU row 0 is at NDC y +1, and negating y reverses the
    // winding so FrontSide would cull the entire pass.
    stampMat.vertexNode = vec4(ndc.x, ndc.y.negate(), 0, 1)

    const rel = world.sub(a)
    const t = saturate(rel.dot(dir).div(len))
    const dist = length(rel.sub(dir.mul(t.mul(len))))
    /** Solid capsule: flat across the patch, convex shoulder. */
    const solid = smoothstep(radius.mul(1.6), radius.mul(0.5), dist)
    /**
     * Annulus: a band centred on `radius`.
     *
     * 0.07 OF THE RADIUS, AND THE FIELD IS 2048 SQUARE TO ALLOW IT. The drawn
     * stroke measured 0.89-0.98% of frame width against the reference chain's
     * 0.47% — a line twice as fat as the painting's. At 0.11 of a 2.84 m radius
     * the authored band is 0.62 m, but the TEXEL FLOOR below was already the
     * binding constraint at 0.167 m per texel, so thinning the fraction alone
     * would have done nothing: the floor has to come down with it, and that is a
     * resolution change. 256 m over 2048 is 0.125 m per texel, so the floor is
     * 0.175 m and the band 0.40 m.
     *
     * THE BAND IS FLOORED AT A TEXEL AND A HALF, and this is the bug that made
     * the ring pulses invisible even after their quads stopped being degenerate.
     * `radius * 0.20` on a 2.3 m ring is 0.46 m, and its full-amplitude core —
     * `|dist - radius| < radius * 0.05` — is 0.115 m, a THIRD of a texel. A
     * feature that narrow misses every pixel centre except by luck, so the
     * rings rasterised at a fraction of their authored amplitude and the
     * material's lace threshold then removed what was left: measured from a
     * lifted camera, the trail was two thin dashed wheel lines and no rings at
     * all, at wakeShare 0.000.
     *
     * The deform field documents the same class of failure for the WIDTH of a
     * capsule ("a sub-texel quad misses every pixel centre") and this pass
     * inherited that guard on `radius` — but a ring's radius is not its line
     * width, and the guard has to be on whichever of the two is smaller.
     */
    const bandHalf = max(radius.mul(par.z.max(0.02)), float(WAKE_SPAN / WAKE_RES * 1.4))
    // RAGGED, not a tube. The reference's ring stroke is bitten along its inner
    // edge, varies in width around the circle and sheds detached flecks; ours was
    // a constant-width gaussian tube, which is what made the trail read as a
    // bicycle chain of identical hoops. One noise tap on the world position
    // modulates the band width around each ring, and because it is keyed to
    // WORLD position rather than to angle it also varies between rings for free.
    // TWO SCALES OF LUMP, because one was not enough. Measured against
    // refs/water/shore-foam-wake.jpg from a matched top-down camera: the
    // reference's ring stroke is thick (about an eighth of the ring radius) and
    // varies in width in BIG LOBES around the circle, with clumpy thickenings
    // and thin bitten-away stretches between them. A single 0.6 m noise on a
    // hairline band gives fine fizz on a line of constant apparent weight — the
    // eye reads it as a technical pen, not foam. The low tap (about 4 m) does the
    // lobes, the high tap keeps the edge bitten.
    const lobe = mx_noise_float(vec3(world.mul(0.26), 1.7)).mul(0.55).add(1)
    const bite = mx_noise_float(vec3(world.mul(1.7), 0)).mul(0.45).add(1)
    const ragged = lobe.mul(bite)
    const ring = smoothstep(
      bandHalf.mul(ragged), bandHalf.mul(0.2), abs(dist.sub(radius)),
    )
    // THE RING INTERIOR CARRIES BROKEN FROTH, and this is what turns a chain of
    // hoops into a wake.
    //
    // Measured against `refs/water/shore-foam-wake.jpg`: the reference's wake has
    // 121 enclosed holes with the largest 3.4% of frame width and fills 56% of the
    // region it occupies. A chain of smooth rings has 4 holes at 5.8%W — the
    // holes ARE the ring interiors — and the same topology reads as skywriting
    // because the pockets are two orders of magnitude too few and too large.
    //
    // Filling the interior solid was tried much earlier and is the slab. What the
    // reference actually has is a MASS with pinholes, so the interior gets a
    // noise at about two and a half texels, peaking well below the ring's own
    // amplitude: enough that the material's age-driven lace threshold leaves
    // scattered froth rather than clean water, and the big void becomes many
    // small ones.
    const insideDisc = smoothstep(radius, radius.mul(0.82), dist)
    const froth = mx_noise_float(vec3(world.mul(3.2), 4.1)).mul(0.5).add(0.5)
    // 0.28, down from 0.45. The reference's wake is a chain of rings with water
    // showing THROUGH them — `fill` 0.562 — and at 0.45 the interiors filled in
    // enough that `water-wake` measured 0.744 and its largest foam component had
    // a bounding-box fill of 0.72 against the reference's 0.33. The froth still
    // has to be there, or the ring interiors become four big voids instead of
    // many small ones; it just must not close them.
    const ringMass = max(ring, insideDisc.mul(froth).mul(0.28))
    const shape = mix(solid.mul(solid), ringMass, par.w)
    const amount = shape.mul(par.y).clamp(0, 1)
    const contact = shape.mul(aux.x).clamp(0, 1)
    stampMat.fragmentNode = vec4(
      amount,                          // R foam, long-lived
      contact,                         // G contact froth, short-lived
      0,
      smoothstep(0.03, 0.2, amount),   // A freshness, reset to 1 by any mark
    )
    stampMat.blending = THREE.CustomBlending
    stampMat.blendEquation = THREE.MaxEquation
    stampMat.blendEquationAlpha = THREE.MaxEquation
    stampMat.blendSrc = THREE.OneFactor
    stampMat.blendDst = THREE.OneFactor
    stampMat.blendSrcAlpha = THREE.OneFactor
    stampMat.blendDstAlpha = THREE.OneFactor
    stampMat.depthTest = false
    stampMat.depthWrite = false
    stampMat.transparent = true
    stampMat.side = THREE.DoubleSide
    stampMat.name = 'water-wake-stamp'

    this.stampGeo = new THREE.InstancedBufferGeometry()
    this.stampGeo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3,
    ))
    this.stampGeo.setIndex([0, 1, 2, 0, 2, 3])
    this.stampGeo.setAttribute('iSeg', this.stampSeg)
    this.stampGeo.setAttribute('iParams', this.stampPar)
    this.stampGeo.setAttribute('iAux', this.stampAux)
    const wrapAttr = new THREE.InstancedBufferAttribute(new Float32Array(STAMP_INSTANCES), 1)
    for (let i = 0; i < STAMP_INSTANCES; i++) wrapAttr.array[i] = Math.floor(i / STAMP_MAX)
    this.stampGeo.setAttribute('iWrapIndex', wrapAttr)
    this.stampGeo.instanceCount = 0
    const stampMesh = new THREE.Mesh(this.stampGeo, stampMat)
    stampMesh.frustumCulled = false
    this.stampScene.add(stampMesh)

    // ── decay, with a DILATION in it ────────────────────────────────────────
    // Foam spreads outward as it dies. A pure fade reads as a stripe going
    // grey; the reference's rings get WIDER and softer as they get fainter, so
    // each decay tick takes the max of the texel and 0.55 of its four
    // neighbours. The weight is well under one on purpose — it makes a soft
    // one-to-two texel halo that the fade then eats, rather than a front that
    // marches outward forever.
    const px = float(1 / WAKE_RES)
    const c = vec4(this.decaySrc.sample(uv()))
    const n1 = vec4(this.decaySrc.sample(uv().add(vec2(px, 0))))
    const n2 = vec4(this.decaySrc.sample(uv().sub(vec2(px, 0))))
    const n3 = vec4(this.decaySrc.sample(uv().add(vec2(0, px))))
    const n4 = vec4(this.decaySrc.sample(uv().sub(vec2(0, px))))
    const spread = max(max(n1.r, n2.r), max(n3.r, n4.r)).mul(0.55)
    const dt = this.decayDt
    this.decayMaterial.fragmentNode = vec4(
      max(c.r, spread).sub(dt.div(FOAM_LIFE)).max(0),
      // G, and NO dilation term: contact froth clings to the hull rather than
      // spreading outward the way a dying wake does.
      c.g.sub(dt.div(CONTACT_LIFE)).max(0),
      0,
      // Freshness runs out FASTER than the foam, so an old mark is fully laced
      // while it is still visible. That is the dissolve.
      c.a.sub(dt.div(FOAM_LIFE * 0.55)).max(0),
    )
    this.decayMaterial.blending = THREE.NoBlending
    this.decayMaterial.depthTest = false
    this.decayMaterial.depthWrite = false
    this.decayMaterial.name = 'water-wake-decay'

    this.clearMaterial.fragmentNode = vec4(0, 0, 0, 0)
    this.clearMaterial.blending = THREE.NoBlending
    this.clearMaterial.depthTest = false
    this.clearMaterial.depthWrite = false
    this.clearMaterial.name = 'water-wake-clear'
  }

  /** The material's read hook: (foam, freshness) at a world XZ. */
  sample(worldXZ: Node<'vec2'>): {
    foam: Node<'float'>; fresh: Node<'float'>; contact: Node<'float'>
  } {
    const t = vec4(texture(this.rt.texture, worldXZ.div(WAKE_SPAN).fract()))
    return { foam: t.r, fresh: t.a, contact: t.g }
  }

  private writeStamps(stamps: readonly FoamStamp[]): void {
    const n = Math.min(stamps.length, STAMP_MAX)
    const seg = this.stampSeg.array as Float32Array
    const par = this.stampPar.array as Float32Array
    const aux = this.stampAux.array as Float32Array
    for (let w = 0; w < WRAP; w++) {
      for (let i = 0; i < n; i++) {
        const s = stamps[i]!
        const o = (w * STAMP_MAX + i) * 4
        seg[o] = s.ax; seg[o + 1] = s.az; seg[o + 2] = s.bx; seg[o + 3] = s.bz
        par[o] = s.radius; par[o + 1] = s.amount
        par[o + 2] = s.band; par[o + 3] = s.ring
        const a2 = (w * STAMP_MAX + i) * 2
        aux[a2] = s.contact; aux[a2 + 1] = 0
      }
      // Instances past `n` in each wrap slice are collapsed to a zero-amount
      // dot rather than left holding last frame's segment.
      for (let i = n; i < STAMP_MAX; i++) {
        const o = (w * STAMP_MAX + i) * 4
        seg[o] = 0; seg[o + 1] = 0; seg[o + 2] = 0; seg[o + 3] = 0
        par[o] = 0; par[o + 1] = 0; par[o + 2] = 0; par[o + 3] = 0
        const a2 = (w * STAMP_MAX + i) * 2
        aux[a2] = 0; aux[a2 + 1] = 0
      }
    }
    this.stampSeg.needsUpdate = true
    this.stampPar.needsUpdate = true
    this.stampAux.needsUpdate = true
    this.stampGeo.instanceCount = STAMP_INSTANCES
  }

  /**
   * Render-graph pass 10a: stamp, then decay.
   *
   * `renderAsync`, not `render`: three silently skips draws whose pipeline is
   * still compiling, and a stamp skipped on frame 1 of a capture is a mark that
   * only sometimes exists.
   */
  async update(
    renderer: THREE.Renderer, dt: number, stamps: readonly FoamStamp[],
  ): Promise<void> {
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear

    if (!this.cleared) {
      this.cleared = true
      renderer.autoClear = true
      for (const rt of [this.rt, this.scratch]) {
        this.quad.material = this.clearMaterial
        renderer.setRenderTarget(rt)
        await renderer.renderAsync(this.quad, this.flatCam)
      }
    }

    // The stamp writes a subset of the target, so it must not clear it.
    renderer.autoClear = false
    if (stamps.length > 0) {
      this.writeStamps(stamps)
      renderer.setRenderTarget(this.rt)
      await renderer.renderAsync(this.stampScene, this.flatCam)
    }

    // DECAY CADENCE, for the reason field.ts gives: at unorm8 a pass that moves
    // a channel by less than 1/255 rounds straight back and nothing ever fades.
    // One tick of `FOAM_LIFE / 255` is 43 ms, so every-frame decay would be
    // inside the quantisation dead band at 60 fps and would stall outright on a
    // faster display. Every fourth frame is nearly three steps of headroom.
    this.debt += dt
    if (this.frame % 4 === 0 && this.debt > 0) {
      this.decayDt.value = this.debt
      this.debt = 0
      this.quad.material = this.decayMaterial
      renderer.autoClear = true
      renderer.setRenderTarget(this.scratch)
      await renderer.renderAsync(this.quad, this.flatCam)
      renderer.copyTextureToTexture(this.scratch.texture, this.rt.texture)
    }

    renderer.autoClear = prevAutoClear
    renderer.setRenderTarget(prevTarget)
    this.frame++
  }

  /**
   * Read the field back and describe it. Diagnostic, never on a frame path.
   *
   * The instrument that separates "the stamp did not run", "it ran somewhere
   * else" and "it ran and the material is not showing it" — three failures that
   * look identical in a screenshot, and two of which this system has already
   * had. Returns an ASCII map in the `WINDOW` metres around (cx, cz) as well as
   * whole-field totals, because a mark that is present but mirrored about the
   * field centre reads as "empty" to any local probe (see the y-negation note
   * in src/deform/field.ts, which is exactly that bug).
   */
  async debugScan(
    renderer: THREE.Renderer, cx: number, cz: number, window = 60,
  ): Promise<unknown> {
    const buf = await renderer.readRenderTargetPixelsAsync(
      this.rt, 0, 0, WAKE_RES, WAKE_RES,
    ) as Uint8Array
    let nonzero = 0
    let peak = 0
    for (let i = 0; i < WAKE_RES * WAKE_RES; i++) {
      const v = buf[i * 4] as number
      if (v > 2) nonzero++
      if (v > peak) peak = v
    }
    const N = 33
    const rows: string[] = []
    const at = (x: number, z: number): number => {
      const u = ((x / WAKE_SPAN) % 1 + 1) % 1
      const v = ((z / WAKE_SPAN) % 1 + 1) % 1
      const i = Math.min(WAKE_RES - 1, Math.floor(u * WAKE_RES))
      // Row 0 of the buffer is v = 0, the same convention the sampler uses.
      const j = Math.min(WAKE_RES - 1, Math.floor(v * WAKE_RES))
      return (buf[(j * WAKE_RES + i) * 4] as number) / 255
    }
    for (let j = 0; j < N; j++) {
      let line = ''
      for (let i = 0; i < N; i++) {
        const x = cx + (i / (N - 1) * 2 - 1) * window
        const z = cz + (j / (N - 1) * 2 - 1) * window
        const m = at(x, z)
        line += m > 0.75 ? '#' : m > 0.5 ? '+' : m > 0.25 ? ':' : m > 0.02 ? '.' : ' '
      }
      rows.push(line)
    }
    return {
      res: WAKE_RES, span: WAKE_SPAN, nonzero, peak: peak / 255,
      coverage: nonzero / (WAKE_RES * WAKE_RES), centre: [cx, cz], window, rows,
    }
  }

  dispose(): void {
    this.rt.dispose()
    this.scratch.dispose()
  }
}

function makeTarget(name: string): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(WAKE_RES, WAKE_RES, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Toroidal in both axes. Non-negotiable — the sampler uses `fract`.
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
  })
  rt.texture.colorSpace = THREE.NoColorSpace
  rt.texture.name = name
  return rt
}
