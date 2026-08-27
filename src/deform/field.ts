// The deformation field — storage, write, decay.
//
// ARCHITECTURE, "The deformation field". Two toroidal tiers that scroll with
// the player so the cost is bounded no matter how big the world is:
//
//   near      2048², 256 m coverage, written every frame
//   committed 1024², 2 km coverage, retains marks outside the near field
//
// TOROIDAL, concretely: a world point maps to `fract(worldXZ / SPAN)` and
// therefore ALWAYS lands on the same texel. Nothing is ever copied to make the
// window move; the window moving just changes which texels are still
// meaningful. The centre is only used to answer "is this texel inside my
// coverage", and the wrap seam sits exactly at the coverage boundary — which is
// where the sampler has already faded to zero. There is no seam artefact to fix
// because the only texels that could show one are at zero weight.
//
// PROMOTE / DEMOTE. Every stamp is written to BOTH tiers, so promotion is not
// an event: the committed tier already holds a coarse copy of every mark by the
// time the player leaves it. Demotion is the band refill in `recentre` — the
// strip of near texels that changed meaning this frame is re-seeded from the
// committed tier, so driving back into somewhere you left brings your marks
// back with you.
//
// WHY unorm8, AND WHY THE DECAY CADENCE. Four 8-bit channels make the near
// field 16 MB instead of the 64 MB rgba16f would cost, against a 400 MB budget
// for the whole game. The price is quantisation: a decay pass that moves a
// channel by less than 1/255 rounds straight back and the mark never fades at
// all. So the decay pass does NOT run every frame — it runs every DECAY_EVERY
// frames with the accumulated dt, sized so the slowest non-permanent surface
// (snow, 90 s) still clears one quantisation step per pass. Mud, at 1200 s,
// moves less than one step and therefore does not move: ART_BIBLE's
// "essentially permanent until rain" and the arithmetic agree by construction.

import * as THREE from 'three/webgpu'
import {
  abs, attribute, float, floor, fract, length, max, mix, mod, positionGeometry,
  saturate, smoothstep, texture, uniform, uv, vec2, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { DeformHook, DeformSample } from '../material/painterly'
import type { DeformResponse } from './biome'

// ── geometry of the two tiers ───────────────────────────────────────────────
export const NEAR_RES = 2048
export const NEAR_SPAN = 256
export const COMMIT_RES = 1024
export const COMMIT_SPAN = 2048

/** Metres of displacement at R = 1. Above ART_BIBLE's deepest (snow, 0.35). */
export const DEPTH_SCALE = 0.4
/** Seconds the freshness channel sweeps from 1 to 0. See the header. */
const AGE_SPAN = 120
/**
 * Frames between decay passes. 36 frames = 0.6 s.
 *
 * At the 90 s snow refill that is 0.0067 of the channel — 1.7 quantisation
 * steps, comfortably above the one-step floor below which the fade stalls. It
 * is also 1.3 steps of the freshness channel over AGE_SPAN. Raising the cadence
 * to every frame would make each step 0.05 steps and NOTHING would ever decay.
 */
const DECAY_EVERY = 36
/** Frames between committed stamps. At 2 m per texel, four frames of travel at
 *  top speed is half a texel, so batching them loses nothing. */
const COMMIT_EVERY = 4
/** The coarse tier decays on a coarse clock too. */
const COMMIT_DECAY_EVERY = DECAY_EVERY * 4

/** Wheels × the 3×3 wrap neighbourhood. See the stamp material. */
const WHEELS = 4
const WRAPS = 9
const STAMP_INSTANCES = WHEELS * WRAPS

/** One wheel's contact this frame, in world XZ. */
export interface WheelStamp {
  /** Previous frame's contact point. The stamp is the SEGMENT from here to
   *  (bx, bz), not a dot: at 35 m/s a per-frame dot leaves 0.58 m gaps. */
  ax: number
  az: number
  bx: number
  bz: number
  /** Half-width of the contact patch, metres. Widens with scrub. */
  halfWidth: number
  /** Rut depth this stamp cuts, as a fraction of DEPTH_SCALE. */
  depth: number
  /** Disturbance written, 0..1. */
  mask: number
  /** Wetness written, 0..1. */
  wet: number
}

function makeTarget(res: number, name: string): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(res, res, {
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
  // No sRGB anywhere near this: the channels are metres, masks and seconds.
  rt.texture.colorSpace = THREE.NoColorSpace
  rt.texture.name = name
  return rt
}

/** Unit quad, indexed, corners at (0,0)..(1,1) unless `signed`. */
function quadGeometry(signed: boolean): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  const c = signed
    ? [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]
    : [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c), 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

function dynAttr(count: number, size: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size)
  a.setUsage(THREE.DynamicDrawUsage)
  return a
}

/** One toroidal tier: a render target, a centre, and its scratch buffer. */
class Tier {
  readonly rt: THREE.RenderTarget
  /**
   * Scratch for the decay pass, copied back afterwards.
   *
   * Copied rather than swapped so `rt.texture` stays a stable handle. Swapping
   * would mean re-pointing the terrain material's texture node every 36 frames
   * — a bind-group rebuild on the one material that covers the whole screen,
   * which is a worse deal than a 16 MB blit six times a second.
   */
  readonly scratch: THREE.RenderTarget
  readonly centreNode = uniform(new THREE.Vector2())
  /** Texel-snapped centre. Snapping is what makes the exposed band exact. */
  readonly centre = new THREE.Vector2(NaN, NaN)

  constructor(readonly res: number, readonly span: number, name: string) {
    this.rt = makeTarget(res, `deform-${name}`)
    this.scratch = makeTarget(res, `deform-${name}-scratch`)
  }

  get texelSize(): number { return this.span / this.res }

  dispose(): void { this.rt.dispose(); this.scratch.dispose() }
}

export interface FieldOptions {
  /** Global decay multiplier from the weather. See `weatherDecay`. */
  weather: number
}

/**
 * Storage, write and decay for both tiers, plus the TSL hook the terrain
 * material reads. Knows nothing about vehicles — see `index.ts` for the wiring.
 */
export class DeformField implements DeformHook {
  readonly near = new Tier(NEAR_RES, NEAR_SPAN, 'near')
  readonly committed = new Tier(COMMIT_RES, COMMIT_SPAN, 'committed')

  private nearDebt = 0
  private commitDebt = 0
  private frame = 0
  private cleared = false

  // ── response uniforms ─────────────────────────────────────────────────────
  // One vector for the surface the player is on and one for everything else,
  // blended by a footprint mask. M2's classify() replaces `patchMask` with a
  // real biome-weight sample; every consumer already goes through
  // `responseAt`, so nothing else has to change when it does.
  private readonly rA0 = uniform(new THREE.Vector4(20, 26, 1, 26))
  private readonly rA1 = uniform(new THREE.Vector4(0.3, 0.9, 0.3, 0.5))
  private readonly rB0 = uniform(new THREE.Vector4(20, 26, 1, 26))
  private readonly rB1 = uniform(new THREE.Vector4(0.3, 0.9, 0.3, 0.5))
  /** xy centre, zw half-extent of the surface carrying response A. */
  private readonly patch = uniform(new THREE.Vector4(0, 0, -1, -1))
  private readonly weatherNode = uniform(1)

  // ── passes ────────────────────────────────────────────────────────────────
  private readonly quad = new THREE.QuadMesh()
  /**
   * Camera for the full-screen quad passes (stamp, decay, refill).
   *
   * MUST be an OrthographicCamera, not `new THREE.Camera()`. The base class has
   * no `updateProjectionMatrix`, and WebGPURenderer._updateCamera calls it
   * unconditionally — so every deform pass threw at frame 1 and the page hung
   * before `__ready` ever resolved. Captures with `deform=1` did not run slowly,
   * they never completed at all; without deform the same page is ready in 0.6s.
   *
   * The quad geometry is already in clip space, so the projection is identity
   * and the bounds are the unit cube.
   */
  private readonly flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly stampScene = new THREE.Scene()
  private readonly stampSeg = dynAttr(STAMP_INSTANCES, 4)
  private readonly stampPar = dynAttr(STAMP_INSTANCES, 4)
  private readonly stampGeo = quadGeometry(true)
  private readonly stampSpan = uniform(NEAR_SPAN)
  /** Narrowest half-width the tier being written can actually hold. See the
   *  stamp material — a 0.16 m capsule is 0.26 texels of the committed tier. */
  private readonly stampMinHalf = uniform(0)

  private readonly bandScene = new THREE.Scene()
  /** Same bands, but written as zero without binding any texture. See below. */
  private readonly bandClearScene = new THREE.Scene()
  private readonly bandRects = dynAttr(4, 4)
  private readonly bandGeo = quadGeometry(false)
  private readonly bandSpan = uniform(NEAR_SPAN)
  private readonly bandCentre = uniform(new THREE.Vector2())
  private readonly bandKeep = uniform(1)

  private readonly decayMaterial = new THREE.NodeMaterial()
  private readonly decaySrc = texture(this.near.rt.texture)
  private readonly decaySpan = uniform(NEAR_SPAN)
  private readonly decayCentre = uniform(new THREE.Vector2())
  private readonly decayDt = uniform(0)
  private readonly clearMaterial = new THREE.NodeMaterial()

  constructor(options: FieldOptions) {
    this.weatherNode.value = options.weather

    // ── the stamp: an oriented capsule per wheel contact, MAX-blended ────────
    //
    // MAX rather than alpha or additive, and all four channels want it for the
    // same reason: a second pass over the same ground must never be able to
    // make a mark shallower, fainter, drier or older. MAX is also what keeps
    // this pass BOUNDED — there is no read-modify-write, so nothing has to be
    // copied and the only texels touched are the ones under the wheels. The
    // price is that the peak in R never comes down by itself, which is exactly
    // why `decay` exists as a separate low-cadence pass.
    const seg = attribute<'vec4'>('iSeg', 'vec4')
    const par = attribute<'vec4'>('iParams', 'vec4')
    const a = seg.xy
    const b = seg.zw
    // THE STAMP MUST NEVER BE NARROWER THAN THE TIER IT IS WRITTEN INTO.
    //
    // A tyre's contact patch is 0.16 m half-width. In the near tier that is
    // 2.6 texels of a 0.125 m grid and rasterises fine. In the COMMITTED tier,
    // at 2 m per texel, the whole capsule is 0.26 texels across — a subpixel
    // triangle that misses every pixel centre, and on the rare frame it does
    // cover one, `profile` at that centre is past `halfWidth * 1.5` and
    // evaluates to zero anyway. So the committed tier received NOTHING: a whole
    // -tier scan reads 0 nonzero texels after a 400-frame drive, which is the
    // arithmetic reason persistence never worked, independently of the flip
    // below.
    //
    // The floor is a property of the STORAGE, not of the tyre — 2 m per texel
    // cannot represent anything narrower, so the honest coarse-tier record of a
    // tyre mark is one texel wide. That is also what the committed tier is for:
    // the memory that you drove here, not the tread pattern.
    const halfWidth = max(par.x, this.stampMinHalf)
    const pad = halfWidth.mul(1.9).add(0.22)
    const d = b.sub(a)
    const len = length(d).max(1e-4)
    const dir = d.div(len)
    const perp = vec2(dir.y.negate(), dir.x)
    const corner = positionGeometry.xy
    /** World XZ of this quad corner. Read in both stages; TSL varies it. */
    const world = a.add(b).mul(0.5)
      .add(dir.mul(corner.x.mul(len.mul(0.5).add(pad))))
      .add(perp.mul(corner.y.mul(pad)))

    const stampMat = new THREE.NodeMaterial()
    // The 3×3 wrap neighbourhood. A capsule straddling the toroidal seam has to
    // be drawn on both sides of it or half the mark is missing; the eight
    // copies that land off-target are clipped before rasterisation and cost
    // nothing measurable.
    const wrapIndex = attribute<'float'>('iWrapIndex', 'float')
    const wrapX = mod(wrapIndex, 3).sub(1)
    const wrapZ = floor(wrapIndex.div(3)).sub(1)
    // NDC relative to the wrap cell the SEGMENT lives in, so `fract` is never
    // applied to a quantity that gets interpolated across the quad.
    const cell = floor(a.div(this.stampSpan)).mul(this.stampSpan)
    const ndc = world.sub(cell).div(this.stampSpan).mul(2).sub(1)
      .add(vec2(wrapX, wrapZ).mul(2))
    // Y IS NEGATED, AND THIS IS THE BUG THAT MADE THE FIELD READ EMPTY.
    //
    // Every reader of these tiers treats the texture v axis as "world z within
    // the span": the terrain material samples `fract(worldXZ / SPAN)`, the CPU
    // mirror indexes rows by `round(z * TEXELS_PER_M)`, and both of those are
    // ROW indices — v = 0 is row 0. Under WebGPU, row 0 is at NDC y = +1, not
    // -1 (three's own QuadMesh encodes exactly this: its uv attribute pairs
    // NDC y +1 with v 0). Writing `ndc.y = 2v - 1` therefore rasterised the
    // mark to row (1 - v) * res and every reader looked for it at row v * res.
    //
    // The mark existed the whole time — a whole-tier scan after the 400-frame
    // pan run found 3812 nonzero texels at G up to 228/255 — mirrored about the
    // z centre of the tier, which for this drive put it 700 texels (87 m) from
    // where the mirror's 32 m window was reading. Hence `__trench.deform`
    // returning a flat zero over an 80 x 80 m grid while the stamp pass was in
    // fact running perfectly.
    //
    // WebGL would have hidden this: there NDC y -1 IS row 0, so writer and
    // reader agreed by accident. This is the same class of silent-in-WebGL,
    // fatal-in-WebGP as the band-refill self-read above it.
    stampMat.vertexNode = vec4(ndc.x, ndc.y.negate(), 0, 1)

    const rel = world.sub(a)
    const t = saturate(rel.dot(dir).div(len))
    const dist = length(rel.sub(dir.mul(t.mul(len))))
    // A tyre is not a knife: the profile is flat across the contact patch and
    // falls off over the shoulder. Squared, so the shoulder is convex — which
    // is what makes the rut read as PRESSED rather than cut.
    const profile = smoothstep(halfWidth.mul(1.5), halfWidth.mul(0.45), dist)
    // Tread, at low amplitude on purpose: at 12.5 cm per texel a period much
    // under half a metre aliases into a moiré crawl instead of reading as
    // tread, and the reference shows tyre marks as a textured band, not a row
    // of blocks.
    const tread = rel.dot(dir).mul(13).sin().mul(0.06).add(1)
    const amount = profile.mul(profile).mul(tread).clamp(0, 1)
    stampMat.fragmentNode = vec4(
      par.y.mul(amount),                // R rut depth
      par.z.mul(amount),                // G disturbance mask
      par.w.mul(amount),                // B wetness / compaction
      smoothstep(0.02, 0.14, amount),   // A freshness, reset to 1 by any mark
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
    // DOUBLE SIDED BECAUSE THE Y NEGATION ABOVE REVERSES THE WINDING.
    //
    // The quad's corner order is fixed in `quadGeometry`, so flipping the sign
    // of clip-space y turns every triangle from front- to back-facing and the
    // default FrontSide culls the entire pass — measured, the whole-tier scan
    // went from 3812 nonzero texels in the wrong place to 0 nonzero texels
    // anywhere. Two sides costs nothing on a pass with no depth and no shading
    // that depends on facing, and it is more robust than hand-reversing an
    // index buffer that three is also free to reorder.
    stampMat.side = THREE.DoubleSide
    stampMat.name = 'deform-stamp'

    this.stampGeo.setAttribute('iSeg', this.stampSeg)
    this.stampGeo.setAttribute('iParams', this.stampPar)
    const wrapAttr = new THREE.InstancedBufferAttribute(new Float32Array(STAMP_INSTANCES), 1)
    for (let i = 0; i < STAMP_INSTANCES; i++) wrapAttr.array[i] = Math.floor(i / WHEELS)
    this.stampGeo.setAttribute('iWrapIndex', wrapAttr)
    this.stampGeo.instanceCount = STAMP_INSTANCES
    const stampMesh = new THREE.Mesh(this.stampGeo, stampMat)
    stampMesh.frustumCulled = false
    this.stampScene.add(stampMesh)

    // ── the band refill: demote committed -> near, or clear ─────────────────
    // Up to four rectangles (an x strip, a z strip, and the wrap split of each)
    // in ONE instanced draw. Re-rendering the same material four times with a
    // mutated uniform would also work, and would be four command buffers doing
    // the work of one.
    const rect = attribute<'vec4'>('iRect', 'vec4')
    const bandMat = new THREE.NodeMaterial()
    const bandUv = vec2(rect.xy.add(rect.zw.sub(rect.xy).mul(positionGeometry.xy)))
    // Same v-is-a-row convention as the stamp, and the same negation. `iRect`
    // is authored in TEXTURE uv space by `recentre`, so the fragment that lands
    // on row R has to be the one whose `bandUv.y` is R / res — which under
    // WebGPU means NDC y = 1 - 2v. Without this the demoted strip was written
    // to the mirror image of the strip that had just been exposed: the band
    // that scrolled off the -z edge was refilled at the +z edge, so the near
    // tier was simultaneously missing the marks it should have got back AND
    // corrupted where it had valid ones.
    const bandNdc = vec2(bandUv.x.mul(2).sub(1), bandUv.y.mul(-2).add(1))
    bandMat.vertexNode = vec4(bandNdc, vec2(0, 1))
    const bandWorld = this.windowWorld(bandUv, this.bandCentre, this.bandSpan)
    const fromCommit = texture(this.committed.rt.texture, fract(bandWorld.div(COMMIT_SPAN)))
    // The committed tier has nothing coarser to fall back to — 2 km IS the
    // memory — so its own exposed bands are cleared. `bandKeep` is the switch.
    //
    // The mask and wet channels go through a TOE on the way back down. Without
    // it a demoted mark returns 3.7x too wide: measured, a 7.5 m contiguous
    // smear against the 2.0 m the fresh near-tier pair occupies. Two blurs
    // stack — `stampMinHalf` floors the committed stamp at 0.75 texel = 1.5 m
    // half-width, and then this refill bilinear-upsamples 2 m/texel committed
    // data straight into the 0.125 m/texel near tier, adding roughly another
    // +/-2 m of skirt.
    //
    // That smear is what the persistence gate was actually scoring, which is
    // the "gate satisfied by the wrong thing" failure CLAUDE.md warns about,
    // and ART_BIBLE §4 is explicit that wet sand holds SHARP dark tracks. It
    // also reached physics: the band lands in the near tier, so the CPU mirror
    // handed the car rolling resistance across 7.5 m it never drove through.
    //
    // Cutting the bilinear skirt rather than the mark: the toe removes the low
    // tail the upsample invents and rescales what is left, so a returning mark
    // keeps its peak and loses its shoulders. Depth (r) and age (a) pass
    // through untouched — narrowing a rut's DEPTH would change the ground the
    // car drives on, not just how the mark reads.
    // 0.40 measured, not guessed: swept against the demoted band's across-track
    // extent, which fell 7.5 m -> 3.38 m and then PLATEAUED — 0.40, 0.55 and
    // 0.68 all return 3.38 m. So the toe has removed all of the bilinear skirt,
    // and the 3.38 m that remains is the stored capsule itself: `stampMinHalf`
    // floors the committed stamp at 0.75 texel = 1.5 m half-width, i.e. 3.0 m
    // across before any filtering. Narrowing further means splitting that floor
    // so it applies only perpendicular to the segment and not to the caps —
    // a change to the WRITE side, which this toe cannot reach.
    // Lowest value that reaches the plateau, since a higher toe would start
    // eating genuinely faint old marks for no further narrowing.
    const DEMOTE_TOE = 0.40
    const sharpen = (v: Node<'float'>): Node<'float'> =>
      saturate(v.sub(DEMOTE_TOE).div(1 - DEMOTE_TOE))
    bandMat.fragmentNode = vec4(
      fromCommit.r,
      sharpen(fromCommit.g),
      sharpen(fromCommit.b),
      fromCommit.a,
    ).mul(this.bandKeep)
    bandMat.blending = THREE.NoBlending
    bandMat.depthTest = false
    bandMat.depthWrite = false
    bandMat.side = THREE.DoubleSide
    bandMat.name = 'deform-band'
    this.bandGeo.setAttribute('iRect', this.bandRects)
    this.bandGeo.instanceCount = 0
    const bandMesh = new THREE.Mesh(this.bandGeo, bandMat)
    bandMesh.frustumCulled = false
    this.bandScene.add(bandMesh)

    // A second material that CLEARS, binding nothing.
    //
    // Recentring the committed tier exposes bands that have nothing coarser to
    // fall back to, so they are cleared — and `bandMat` expressed that as
    // `sample(committed) * bandKeep` with bandKeep 0. Multiplying by zero still
    // BINDS the texture, so the pass read and wrote `deform-committed` in one
    // synchronisation scope:
    //
    //   GPUValidationError: [Texture "deform-committed"] usage
    //   (TextureBinding|RenderAttachment) includes writable usage and another
    //   usage in the same synchronization scope
    //
    // WebGPU rejects the whole pass, so the committed tier never recentred —
    // which is a large part of why marks did not survive a round trip. WebGL
    // tolerated the same aliasing silently.
    const bandClearMat = new THREE.NodeMaterial()
    bandClearMat.vertexNode = vec4(bandNdc, vec2(0, 1))
    bandClearMat.fragmentNode = vec4(0, 0, 0, 0)
    bandClearMat.blending = THREE.NoBlending
    bandClearMat.depthTest = false
    bandClearMat.depthWrite = false
    bandClearMat.side = THREE.DoubleSide
    bandClearMat.name = 'deform-band-clear'
    const bandClearMesh = new THREE.Mesh(this.bandGeo, bandClearMat)
    bandClearMesh.frustumCulled = false
    this.bandClearScene.add(bandClearMesh)

    // ── the decay pass ──────────────────────────────────────────────────────
    const s = vec4(this.decaySrc.sample(uv())).toVar()
    const dWorld = this.windowWorld(uv(), this.decayCentre, this.decaySpan)
    const r = this.responseAt(dWorld)
    const age = s.a.oneMinus()
    // The AGE channel driving the RATE, which is the half of "per-biome decay"
    // that a single time constant cannot express: dry sand stands for a moment
    // and then slumps (collapse > 1), wet sand and snow take the mark sharply
    // and then hold it (collapse < 1). Normalised so the mean of `shape` over
    // the life of a mark is 1 and `refill` keeps meaning what it says.
    const shape = mix(float(1), r.collapse, age).mul(float(2).div(r.collapse.add(1)))
    const dt = this.decayDt.mul(this.weatherNode)
    this.decayMaterial.fragmentNode = vec4(
      s.r.sub(dt.div(r.refill.max(0.01)).mul(shape)).max(0),
      s.g.sub(dt.div(r.maskLife.max(0.01)).mul(shape)).max(0),
      s.b.sub(dt.div(r.dry.max(0.01))).max(0),
      s.a.sub(dt.div(AGE_SPAN)).max(0),
    )
    this.decayMaterial.blending = THREE.NoBlending
    this.decayMaterial.depthTest = false
    this.decayMaterial.depthWrite = false
    this.decayMaterial.name = 'deform-decay'

    this.clearMaterial.fragmentNode = vec4(0, 0, 0, 0)
    this.clearMaterial.blending = THREE.NoBlending
    this.clearMaterial.depthTest = false
    this.clearMaterial.depthWrite = false
    this.clearMaterial.name = 'deform-clear'
  }

  /**
   * World XZ of a texture uv, resolved into the window around `centre`.
   *
   * `fract(world / span)` is many-to-one; this picks the one representative
   * inside [centre - span/2, centre + span/2), which is the only one current.
   */
  private windowWorld(
    texUv: Node<'vec2'>, centre: Node<'vec2'>, span: Node<'float'>,
  ): Node<'vec2'> {
    const raw = texUv.mul(span)
    return vec2(centre.add(
      mod(raw.sub(centre).add(span.mul(0.5)), span).sub(span.mul(0.5)),
    ))
  }

  /** Push a resolved response pair in. `patch` is the footprint of response A. */
  setResponse(
    a: DeformResponse, b: DeformResponse,
    patch: { x: number; z: number; halfX: number; halfZ: number } | null,
  ): void {
    this.rA0.value.set(a.refill, a.maskLife, a.collapse, a.dry)
    this.rA1.value.set(a.darken, a.chroma, a.expose, a.edge)
    this.rB0.value.set(b.refill, b.maskLife, b.collapse, b.dry)
    this.rB1.value.set(b.darken, b.chroma, b.expose, b.edge)
    if (patch) this.patch.value.set(patch.x, patch.z, patch.halfX, patch.halfZ)
    else this.patch.value.set(0, 0, -1, -1)
  }

  setWeather(multiplier: number): void { this.weatherNode.value = multiplier }

  /** Blend weight of response A, feathered so a mark's decay law never changes
   *  across a single texel. */
  private patchMask(worldXZ: Node<'vec2'>): Node<'float'> {
    const dd = abs(worldXZ.sub(this.patch.xy)).sub(this.patch.zw)
    return smoothstep(float(-2), float(2), max(dd.x, dd.y)).oneMinus()
  }

  private responseAt(worldXZ: Node<'vec2'>): {
    refill: Node<'float'>; maskLife: Node<'float'>; collapse: Node<'float'>
    dry: Node<'float'>; darken: Node<'float'>; chroma: Node<'float'>
    expose: Node<'float'>; edge: Node<'float'>
  } {
    const t = this.patchMask(worldXZ)
    const p0 = vec4(mix(this.rB0, this.rA0, t))
    const p1 = vec4(mix(this.rB1, this.rA1, t))
    return {
      refill: p0.x, maskLife: p0.y, collapse: p0.z, dry: p0.w,
      darken: p1.x, chroma: p1.y, expose: p1.z, edge: p1.w,
    }
  }

  // ── the read side: DeformHook ─────────────────────────────────────────────

  /**
   * The raw field at a world XZ, both tiers resolved.
   *
   * The near tier wins wherever it is valid and cross-fades to the committed
   * tier at its coverage boundary — which is also where the toroidal seam is,
   * so the fade doubles as the seam hider.
   */
  private field(worldXZ: Node<'vec2'>, vertexStage: boolean): Node<'vec4'> {
    const nearTex = texture(this.near.rt.texture, fract(worldXZ.div(NEAR_SPAN)))
    const commitTex = texture(this.committed.rt.texture, fract(worldXZ.div(COMMIT_SPAN)))
    // A vertex-stage sample has no implicit derivative and WGSL rejects it
    // without an explicit level.
    const n = vertexStage ? nearTex.level(float(0)) : nearTex
    const c = vertexStage ? commitTex.level(float(0)) : commitTex
    const dN = abs(worldXZ.sub(this.near.centreNode))
    const wN = smoothstep(float(NEAR_SPAN * 0.5 - 2), float(NEAR_SPAN * 0.5 - 14), max(dN.x, dN.y))
    const dC = abs(worldXZ.sub(this.committed.centreNode))
    const wC = smoothstep(float(COMMIT_SPAN * 0.5 - 8), float(COMMIT_SPAN * 0.5 - 60), max(dC.x, dC.y))
    return vec4(mix(vec4(c).mul(wC), vec4(n), wN))
  }

  /**
   * Signed vertical displacement in metres. Negative is a rut.
   *
   * The stored channel is UNSIGNED depth, because MAX blending needs a monotone
   * encoding. The sign is produced here, together with the SPOIL a real rut
   * throws up along its edges: a ring of taps reading deeper than the centre
   * means this fragment is on the lip of somebody else's trench, and the
   * material displaced out of it has to go somewhere. That is the whole of the
   * "signed" in the channel table, and it costs four taps rather than a second
   * stored field.
   */
  displace(worldPos: Node<'vec3'>): Node<'float'> {
    const p = vec2(worldPos.x, worldPos.z)
    const here = this.field(p, true).r.toVar()
    const R = 0.42
    const ring = this.field(p.add(vec2(R, 0)), true).r
      .add(this.field(p.add(vec2(-R, 0)), true).r)
      .add(this.field(p.add(vec2(0, R)), true).r)
      .add(this.field(p.add(vec2(0, -R)), true).r)
      .mul(0.25)
    const spoil = max(float(0), ring.sub(here)).mul(0.5)
    return float(here.negate().add(spoil).mul(DEPTH_SCALE))
  }

  /** Everything the fragment stage needs: one value tap plus two for the slope. */
  shade(worldPos: Node<'vec3'>): DeformSample {
    const p = vec2(worldPos.x, worldPos.z)
    const s = vec4(this.field(p, false)).toVar()
    const r = this.responseAt(p)
    // Slope of the DISPLACEMENT, metres per metre, from two forward differences
    // one texel apart. This is what turns a flat dark band into a groove: the
    // painterly ramp reads the perturbed normal and lights the near wall of the
    // rut differently from the far one. ART_BIBLE §2 — "detail lives in the
    // light, not the geometry" — is the literal justification, and it is also
    // the only thing that resolves a 25 cm rut on a mesh with 19 m quads.
    const e = NEAR_SPAN / NEAR_RES
    const dx = this.field(p.add(vec2(e, 0)), false).r.sub(s.r)
    const dz = this.field(p.add(vec2(0, e)), false).r.sub(s.r)
    const slope = vec2(dx, dz).mul(-DEPTH_SCALE / e)
    // A mark's EDGE hardness is authored per biome — dry sand slumps into a
    // smudge, wet sand keeps a knife edge. Applied to the mask rather than to
    // the stamp so it follows the SURFACE, not the moment of writing: a mark
    // that outlives a weather change should soften with the ground it is in.
    //
    // A toe plus a GAMMA, not a smoothstep between two thresholds. Any shaping
    // with an upper edge below 1 SATURATES, and a saturating mask cannot fade —
    // a mark decayed to half its stored value still reads at full contrast, so
    // `tracks-decay` and `tracks-fresh` come out as the same picture. This is
    // monotone in the stored channel all the way to 1.
    const toe = mix(float(0.16), float(0.02), r.edge)
    const gamma = mix(float(1.6), float(0.55), r.edge)
    const shapeMask = (v: Node<'float'>): Node<'float'> =>
      saturate(v.sub(toe).div(toe.oneMinus())).pow(gamma)
    const ramp = shapeMask(s.g).toVar()

    // The knife edge. g(x) = x^k / (x^k + (1-x)^k) — the cheapest S with both
    // endpoints nailed (g(0)=0, g(1)=1 for every k), which matters because a
    // saturating alternative cannot fade and would collapse tracks-decay back
    // onto tracks-fresh.
    //
    // `edge` drives k CUBED, so a surface that does not hold an edge gets
    // essentially none of it: dune sand (0.30) gets k 1.2, wet sand (0.96) 7.6.
    //
    // KNOWN COST, and it is now a MEASURED, DELIBERATE trade rather than a
    // known bug: this curve is steep about 0.5 and crushes everything under it,
    // so a demoted band at stored 0.28 renders around 0.185. Kept anyway,
    // because without it the marks lose to the sand pan's own mottle.
    //
    // THE PLATEAU FIX RECORDED HERE WAS TRIED AND IS WRONG. The prescription
    // was: normalise by the largest ramp within a few texels ALONG the mark
    // (direction perpendicular to the mask gradient, since a persisted band has
    // depth 0.000 and the displacement slope there is noise), shape the
    // resulting cross-section, then multiply the plateau back in — sharpening
    // the profile without crushing the amplitude. Implemented exactly that way
    // and captured, all three deform metrics moved the WRONG WAY at once:
    //
    //     corridor      1.36 -> 1.09   (floor 1.25)
    //     persistence   1.33 -> 1.05   (floor 1.25)
    //     decay ratio   6.84 -> 3.60   (floor 2.00, subject 7.59 -> 4.00)
    //
    // The reason is the same arithmetic that kills the perpendicular ring, and
    // it kills the along-mark version too: at TYRE_HALF 0.16 m against a
    // 0.125 m texel the mark is 2.56 texels wide, so a one-texel forward
    // difference has no reliable direction to give. The estimated `along` lands
    // across the mark as often as not, the plateau collapses onto the
    // fragment's own value, x = 1, and the S is switched off everywhere — which
    // is precisely the 1.51 -> 1.18 that the cross-tap version measured. The
    // plateau cannot be sampled at all until the mark is several texels wide;
    // that is a STORAGE-RESOLUTION problem, not a shading one, and the fix is a
    // denser near tier or a wider stamp, not a cleverer curve.
    const k = mix(float(1), float(8.5), r.edge.mul(r.edge).mul(r.edge))
    const rk = ramp.pow(k)
    const mask = rk.div(rk.add(ramp.oneMinus().pow(k)).max(1e-4))
    return {
      mask, wet: s.b, slope, depth: s.r,
      darken: r.darken, chroma: r.chroma, expose: r.expose,
    }
  }

  // ── the write side ────────────────────────────────────────────────────────

  /**
   * Render-graph pass 3. Re-centre both tiers, refill what that exposed, stamp.
   *
   * `renderAsync` rather than `render`, for the reason sunShadow.ts documents:
   * three silently SKIPS draws whose pipeline is still compiling, and a stamp
   * that is skipped on frame 1 of a capture is a mark that only sometimes
   * exists. That breaks M0's byte-identical contract.
   */
  async update(
    renderer: THREE.Renderer, cx: number, cz: number, stamps: readonly WheelStamp[],
  ): Promise<void> {
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    // Everything here writes a subset of its target. A clear is a load-op on
    // the WHOLE texture and would wipe the field on every single pass.
    renderer.autoClear = false

    if (!this.cleared) {
      this.cleared = true
      renderer.autoClear = true
      for (const tier of [this.near, this.committed]) {
        this.quad.material = this.clearMaterial
        renderer.setRenderTarget(tier.rt)
        await renderer.renderAsync(this.quad, this.flatCam)
        renderer.setRenderTarget(tier.scratch)
        await renderer.renderAsync(this.quad, this.flatCam)
      }
      renderer.autoClear = false
    }

    await this.recentre(renderer, this.near, cx, cz, true)
    await this.recentre(renderer, this.committed, cx, cz, false)

    if (stamps.length > 0) {
      this.writeStamps(stamps)
      this.stampSpan.value = NEAR_SPAN
      // 0.75 of a texel, so the narrowest possible mark still covers a pixel
      // centre whatever sub-texel phase it lands on. At 0.125 m that is 0.094 m
      // against a 0.16 m tyre, i.e. inert for the near tier — it only bites on
      // a stamp that is already unrepresentable.
      this.stampMinHalf.value = this.near.texelSize * 0.75
      renderer.setRenderTarget(this.near.rt)
      await renderer.renderAsync(this.stampScene, this.flatCam)
      if (this.frame % COMMIT_EVERY === 0) {
        this.stampSpan.value = COMMIT_SPAN
        this.stampMinHalf.value = this.committed.texelSize * 0.75
        renderer.setRenderTarget(this.committed.rt)
        await renderer.renderAsync(this.stampScene, this.flatCam)
      }
    }

    renderer.autoClear = prevAutoClear
    renderer.setRenderTarget(prevTarget)
    this.frame++
  }

  /** Render-graph pass 4. Low cadence by design — see the header. */
  async decay(renderer: THREE.Renderer, dt: number): Promise<void> {
    this.nearDebt += dt
    this.commitDebt += dt
    const prevTarget = renderer.getRenderTarget()
    if (this.frame % DECAY_EVERY === 0 && this.nearDebt > 0) {
      await this.runDecay(renderer, this.near, this.nearDebt)
      this.nearDebt = 0
    }
    if (this.frame % COMMIT_DECAY_EVERY === 0 && this.commitDebt > 0) {
      await this.runDecay(renderer, this.committed, this.commitDebt)
      this.commitDebt = 0
    }
    renderer.setRenderTarget(prevTarget)
  }

  private async runDecay(renderer: THREE.Renderer, tier: Tier, dt: number): Promise<void> {
    this.decaySrc.value = tier.rt.texture
    this.decaySpan.value = tier.span
    this.decayCentre.value.copy(tier.centre)
    this.decayDt.value = dt
    this.quad.material = this.decayMaterial
    renderer.setRenderTarget(tier.scratch)
    await renderer.renderAsync(this.quad, this.flatCam)
    renderer.copyTextureToTexture(tier.scratch.texture, tier.rt.texture)
  }

  /**
   * Move a tier's window and re-seed whatever that exposed.
   *
   * Exactly the band that changed meaning, in at most four rectangles: an x
   * strip, a z strip, and the wrap split of each. Nothing else is touched, so
   * the cost is proportional to how fast the player is moving rather than to
   * the size of the tier — which is the entire point of a toroidal buffer.
   */
  private async recentre(
    renderer: THREE.Renderer, tier: Tier, cx: number, cz: number, keep: boolean,
  ): Promise<void> {
    const ts = tier.texelSize
    const nx = Math.round(cx / ts) * ts
    const nz = Math.round(cz / ts) * ts
    if (nx === tier.centre.x && nz === tier.centre.y) return
    const ox = tier.centre.x
    const oz = tier.centre.y
    const first = !Number.isFinite(ox)
      || Math.abs(nx - ox) >= tier.span || Math.abs(nz - oz) >= tier.span
    tier.centre.set(nx, nz)
    tier.centreNode.value.set(nx, nz)

    /** axis, u0, u1 triples in texture uv space. */
    const rects: number[] = []
    const pushBand = (lo: number, hi: number, axis: 0 | 1): void => {
      if (hi - lo >= tier.span) { rects.push(axis, 0, 1); return }
      const u0 = lo / tier.span
      const f0 = u0 - Math.floor(u0)
      const f1 = f0 + (hi - lo) / tier.span
      if (f1 <= 1) rects.push(axis, f0, f1)
      else { rects.push(axis, f0, 1, axis, 0, f1 - 1) }
    }
    if (first) {
      rects.push(0, 0, 1)
    } else {
      const h = tier.span * 0.5
      if (nx > ox) pushBand(ox + h, nx + h, 0)
      else if (nx < ox) pushBand(nx - h, ox - h, 0)
      if (nz > oz) pushBand(oz + h, nz + h, 1)
      else if (nz < oz) pushBand(nz - h, oz - h, 1)
    }
    if (rects.length === 0) return

    const arr = this.bandRects.array as Float32Array
    let n = 0
    for (let i = 0; i + 2 < rects.length && n < 4; i += 3, n++) {
      const axis = rects[i] as number
      const a0 = rects[i + 1] as number
      const a1 = rects[i + 2] as number
      if (axis === 0) arr.set([a0, 0, a1, 1], n * 4)
      else arr.set([0, a0, 1, a1], n * 4)
    }
    this.bandGeo.instanceCount = n
    this.bandRects.needsUpdate = true
    this.bandSpan.value = tier.span
    this.bandCentre.value.set(nx, nz)
    this.bandKeep.value = keep ? 1 : 0
    renderer.setRenderTarget(tier.rt)
    // `keep` false means "clear these bands", and the clearing scene binds no
    // texture — which is what keeps a self-read out of the committed recentre.
    await renderer.renderAsync(keep ? this.bandScene : this.bandClearScene, this.flatCam)
  }

  private writeStamps(stamps: readonly WheelStamp[]): void {
    const seg = this.stampSeg.array as Float32Array
    const par = this.stampPar.array as Float32Array
    for (let w = 0; w < WHEELS; w++) {
      const s = stamps[w]
      for (let k = 0; k < WRAPS; k++) {
        const i = (k * WHEELS + w) * 4
        if (!s) { par[i] = 0; par[i + 1] = 0; par[i + 2] = 0; par[i + 3] = 0; continue }
        seg[i] = s.ax; seg[i + 1] = s.az; seg[i + 2] = s.bx; seg[i + 3] = s.bz
        par[i] = s.halfWidth; par[i + 1] = s.depth; par[i + 2] = s.mask; par[i + 3] = s.wet
      }
    }
    this.stampSeg.needsUpdate = true
    this.stampPar.needsUpdate = true
  }

  /**
   * Diagnostic: pull a whole tier back and report WHERE the data is.
   *
   * The CPU mirror can only answer "is there a mark under the car"; when the
   * answer is no, that is equally consistent with "the stamp never ran" and
   * "the stamp ran somewhere else". Scanning the texture itself tells the two
   * apart, and the texel coordinates it returns are what caught the render-
   * target Y flip. Not on any frame path — the harness calls it explicitly.
   */
  async debugScan(
    renderer: THREE.Renderer, which: 'near' | 'committed' = 'near',
  ): Promise<{
    res: number; span: number; centre: [number, number]
    nonzero: number; max: [number, number, number, number]
    argmaxG: [number, number]; worldOfArgmax: [number, number]
    map: string[]
  }> {
    const tier = which === 'near' ? this.near : this.committed
    const buf = await renderer.readRenderTargetPixelsAsync(
      tier.rt, 0, 0, tier.res, tier.res,
    ) as unknown as Uint8Array
    // 2048*4 and 1024*4 are both multiples of 256, so rows come back packed.
    const stride = Math.ceil(tier.res * 4 / 256) * 256
    const max: [number, number, number, number] = [0, 0, 0, 0]
    let nonzero = 0
    let bx = -1
    let by = -1
    for (let y = 0; y < tier.res; y++) {
      const row = y * stride
      for (let x = 0; x < tier.res; x++) {
        const o = row + x * 4
        const g = buf[o + 1] ?? 0
        if (g > 2) nonzero++
        if (g > max[1]) { max[1] = g; bx = x; by = y }
        const r = buf[o] ?? 0
        const b = buf[o + 2] ?? 0
        const a = buf[o + 3] ?? 0
        if (r > max[0]) max[0] = r
        if (b > max[2]) max[2] = b
        if (a > max[3]) max[3] = a
      }
    }
    // 64x64 max-pooled map of G, so the shape and the PLACE are both visible.
    const N = 64
    const cell = tier.res / N
    const map: string[] = []
    for (let j = 0; j < N; j++) {
      let line = ''
      for (let i = 0; i < N; i++) {
        let m = 0
        for (let y = j * cell; y < (j + 1) * cell; y++) {
          const row = y * stride
          for (let x = i * cell; x < (i + 1) * cell; x++) {
            const g = buf[row + x * 4 + 1] ?? 0
            if (g > m) m = g
          }
        }
        line += m > 192 ? '#' : m > 128 ? '+' : m > 64 ? ':' : m > 6 ? '.' : ' '
      }
      map.push(line)
    }
    return {
      res: tier.res, span: tier.span, centre: [tier.centre.x, tier.centre.y],
      nonzero, max, argmaxG: [bx, by],
      worldOfArgmax: [(bx + 0.5) / tier.res * tier.span, (by + 0.5) / tier.res * tier.span],
      map,
    }
  }

  dispose(): void { this.near.dispose(); this.committed.dispose() }
}
