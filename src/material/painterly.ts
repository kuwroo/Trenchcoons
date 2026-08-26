// The ONE shared painterly material — terrain, foliage, rock, props.
//
// ART_BIBLE §3. Per-asset params, never per-asset shaders. NPR: there is no
// metal/roughness anywhere in here, and no specular term at all.
//
// The five things doing the work, in order of how much they matter:
//
//   1. Ambient is sky irradiance from the atmosphere LUT, so unlit faces are
//      SKY-COLOURED and lifted rather than dark grey. Delete this and the whole
//      look goes with it.
//   2. Three authored colours (shadow / base / lit) selected by a 3-stop ramp,
//      so the shadow hue is independent of the lit hue.
//   3. A vertical gradient along the object up-axis. Cheap, and it is most of
//      what reads as "sculpted" in the Genshin and Capy references.
//   4. Saturation RISES with luminance. The single biggest departure from a
//      physical renderer.
//   5. A triplanar brush overlay modulating value and saturation slightly.
//      brushStrength 0 = flat cel, 1 = gouache.

import * as THREE from 'three/webgpu'
import {
  cameraPosition, cos, cross, dFdx, dFdy, dot, exp2, float, floor, log2, luminance,
  mix, mx_noise_float, normalWorld, normalize, positionLocal, positionWorld, pow,
  saturate, sign, sin, smoothstep, uniform, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { boostSaturation, gradeSaturation, setSaturation } from '../atmosphere/scattering'

/**
 * Everything an asset definition is allowed to say about its surface.
 * Colours are sRGB hex; they are converted to the linear working space once.
 */
export interface PainterlyParams {
  /** Mid stop — the colour most of the surface reads as. */
  base: number
  /** Shadow stop. Authored independently so it can be tinted toward the sky. */
  shadow: number
  /** Lit stop. Authored brighter AND more saturated than base. */
  lit: number
  /** Hue multiplier applied at the top of the object's up-axis sweep. */
  top: number
  /** Brightness multiplier at the top. >1 makes the summit lighter. */
  topGain: number
  /** Object-space Y where the vertical gradient starts, metres. */
  gradientBase: number
  /** Object-space height the gradient runs over, metres. */
  gradientHeight: number
  /** 0 = off, 1 = full `top` tint at the summit. */
  gradientStrength: number
  /** N.L at the shadow -> mid ramp step. */
  rampShadow: number
  /** N.L at the mid -> lit ramp step. */
  rampMid: number
  /** Half-width of both ramp steps. Small = cel, large = soft. */
  rampSoftness: number
  /** Direct-light level on the mid stop. The lit stop is always 1. */
  midLevel: number
  /** 0 = flat cel, 1 = gouache. */
  brushStrength: number
  /** Metres per brush stroke. Keep this low-frequency. */
  brushScale: number
  /** How much of the brush signal goes into saturation vs value. */
  brushSaturation: number
  /**
   * Micro-relief. The brush field re-read as a height field and folded into the
   * shading normal — no geometry is displaced.
   *
   * ART_BIBLE §2 says "detail lives in the light, not the geometry", and this is
   * the literal implementation of that: the heightfield stays smooth, big and
   * simple, and the small-scale form that every reference carries on every
   * hillside comes from the ramp reacting to a perturbed normal. 0 = the
   * geometric normal, 1 = roughly 45-degree stroke facets.
   */
  detailStrength: number
  /**
   * Ambient modulation from the relief's HEIGHT rather than its normal — the
   * cheapest possible ambient occlusion, and the only part of micro-relief that
   * survives with no key light at all.
   *
   * Separate from `detailStrength` on purpose. The normal-tilt half acts through
   * the ramp, so its effect scales with how hard the key is raking: at a 7deg sun
   * a tiny tilt flips a whole patch onto the next stop, which is what took
   * greybox-dusk to 1.6x the reference band while the ambient-only frames sat at
   * half of it. The height half acts through the fill and is nearly independent
   * of sun elevation. Tying them to one knob meant every attempt to calm the
   * raking frames flattened the shaded ones by the same amount.
   */
  reliefShade: number
  /** Sky-coloured rim. Sells volume without specular. */
  rimStrength: number
  rimPower: number
  /** How much saturation rises with luminance. */
  saturationGain: number
  /**
   * How far the shadow stop rotates toward the CURRENT sky hue, 0..1.
   *
   * ART_BIBLE §2 says shadows are "tinted toward the sky hue", and round 1 read
   * that as a hex to author once. It cannot be: a teal shadow under a teal noon
   * sky is saturated, but the same teal under an orange dusk sky multiplies out
   * to grey — which is exactly why greybox-dusk measured meanSat 0.17. Rotating
   * the stop toward the live sky hue keeps the shadow chromatic at every time of
   * day and makes the rule dynamic instead of baked.
   *
   * Kept small. The references cool their shade, they do not recolour it:
   * grasslands.jpg grass-shadow is rgb(83,154,88), still unmistakably GREEN at
   * hue 124. Past ~0.3 the grass shade goes navy.
   */
  shadowSkyTint: number
  /** Per-asset scale on the sky ambient. */
  ambient: number
}

export const PAINTERLY_DEFAULTS: PainterlyParams = {
  base: 0x5eb02e,
  shadow: 0x2c6e58,
  lit: 0xb7e83a,
  top: 0xd8ff70,
  topGain: 1.12,
  gradientBase: 0,
  gradientHeight: 6,
  gradientStrength: 0,
  // Thresholds sit HIGH on purpose, and they are AUTHORED FOR THE NOON SUN.
  //
  // Round 1 used -0.05 / 0.42, and with a 58deg noon sun almost every up-facing
  // surface in the world cleared 0.42 — so the whole terrain selected the `lit`
  // stop and the frame was one lime wash with a p05..p95 value range of 0.19
  // against 0.51 in cliffs-tohad.jpg. At 0.30 / 0.88 flat ground sits on the MID
  // stop at noon and only slopes genuinely turned toward the sun reach `lit`.
  //
  // At any other hour these are scaled by `rampScale` (see tod.ts), because a
  // threshold compared against a raw N.L cannot mean the same thing at a 58deg
  // sun and a 7deg one.
  rampShadow: 0.3,
  rampMid: 0.88,
  rampSoftness: 0.3,
  midLevel: 0.33,
  brushStrength: 0.55,
  brushScale: 3.2,
  brushSaturation: 0.55,
  detailStrength: 0.14,
  reliefShade: 0.88,
  rimStrength: 0.5,
  rimPower: 3,
  saturationGain: 0.2,
  shadowSkyTint: 0.18,
  ambient: 1,
}

/**
 * Projected width of the FINEST brush octave, in screen pixels.
 *
 * This number replaces the distance-fade ladder rounds 1-3 used, and the
 * replacement is the whole point of this pass.
 *
 * A world-distance fade cannot work here. Round 1 faded the fine octave out by
 * 240 m and round 3 by 340 m, while every shot camera sits 14-180 m up looking
 * at ground 260 m+ away — so the octave that carries actual stroke character
 * was multiplied by zero in all thirteen PNGs and had literally never been
 * rendered. Pushing the fade further out is not a fix either: procedural noise
 * has no mip chain, so a world-locked octave that survives to 3 km is a
 * sub-pixel octave in the near field and aliases into radial streaks.
 *
 * The quantity that actually matters is not "how far away is this" but "how big
 * is one stroke ON SCREEN". Selecting octaves by projected size makes the brush
 * frequency constant in screen space while every octave stays rigidly
 * world-locked — so it never crawls, never aliases, and is present at 3 m and
 * at 3 km.
 *
 * 20 px, not 8. At 8 px the field was technically above Nyquist and still wrong:
 * a 3-stop ramp reading a normal that turns over every four pixels aliases into
 * dotted stipple along every ridge, and the surface read as combed fur rather
 * than as brushwork. The references' marks are big — a stroke in cliffs-tohad is
 * 15-40 px at 1200 px wide — and a bigger mark also raises per-tile variance for
 * the same amplitude, because less of it averages out inside the tile.
 */
const STROKE_PX = 20

/**
 * World period of the unfaded macro octave, in units of `brushScale`.
 *
 * The LOD ladder tops out around 8x the finest octave, which at a gameplay
 * camera is ~20 m — small enough that a vista frame would lose the big patches
 * of value the references break their masses into. This one is never
 * LOD-selected: it is low-frequency enough that it cannot alias at any range.
 */
const MACRO_STEP = 24

/**
 * Normalisation so `brushStrength` means what its docstring says.
 *
 * This constant is the fix for the bug that made `brushStrength` a lie for
 * three rounds. `mx_noise_float` is gradient noise: its nominal range is
 * [-1, 1] but its standard deviation is only ~0.11 after the triplanar blend,
 * and averaging several octaves at weights that sum to 1 divides that by another
 * two. The composite field came out at sigma 0.053 — so `meadow` asking for
 * brushStrength 1.45 was actually getting a +/-5% value wobble, not gouache,
 * and no amount of turning the authored knob up could reach the references
 * because the knob tops out well before the signal does.
 *
 * 1.03 puts the composite at roughly sigma 0.055, i.e. brushStrength 1.0 is a
 * +/-14% swing in value at one sigma and the authored range 0.35..1.45 spans
 * "barely there" to "clearly gouache", which is what ART_BIBLE §3 asks the knob
 * to mean. It also fixes the relief layer, which reads the same field: at the
 * old amplitude the normal was being tilted by ~7 degrees, which is invisible.
 */
const BRUSH_GAIN = 1.03

/**
 * Radians of stroke rotation per octave. Irrational multiple of pi/2 so no two
 * octaves in the ladder ever line up.
 */
const SPIN_STEP = 1.13

const _c = new THREE.Color()
function hexToLinear(hex: number, out: THREE.Vector3): THREE.Vector3 {
  _c.setHex(hex, THREE.SRGBColorSpace)
  return out.set(_c.r, _c.g, _c.b)
}

/**
 * One flat-brush mark. Value noise with the across-stroke axis squashed ~3x,
 * which is what makes it read as a loaded brush dragged sideways rather than as
 * isotropic texture noise. Squashing harder than this stops reading as a mark
 * and starts reading as fur.
 *
 * Deliberately ONE tap. The second, stretched tap the previous version added
 * existed to give a stroke internal grain at a fixed world frequency; the LOD
 * ladder below now supplies that grain as a real octave, at a controlled
 * projected size, so paying for it twice bought nothing. Three ladder octaves
 * plus the macro octave is 12 triplanar taps, and the relief layer adds 4 more:
 * 16 noise evaluations per fragment, down from the previous 18. Measured at 60
 * fps vsync-locked with p99 19.4 ms at 1600x900 (tools/perf.mjs).
 */
function brushStroke(p: Node<'vec2'>, spin: Node<'float'>): Node<'float'> {
  // Every octave is turned by its own angle. Without this every octave
  // squashes along the same axis and they stack into long parallel streaks — the
  // surface reads as combed fur, not as brushwork. The angle is a function of
  // the octave's ABSOLUTE rung, not its index in the ladder, so it survives the
  // LOD handover: rung n's octave has the same orientation whether it is being
  // used as band 0's top or band 1's bottom.
  const c = cos(spin)
  const s = sin(spin)
  const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)))
  return mx_noise_float(vec3(q.x, q.y.mul(0.36), 0.0))
}

/**
 * A flat-topped mark rather than a smooth blob.
 *
 * Raw gradient noise is a maze of soft lobes: turned up it reads as worms, and
 * that was the honest complaint about the first version of this pass. Gouache
 * does not do soft lobes — it lays down a patch of one value with a crisp
 * boundary. Pushing each octave through a soft step gives exactly that: flat
 * interiors, defined edges, still band-limited (the step's width is a constant
 * fraction of the octave's own amplitude, so nothing new is introduced above the
 * octave's frequency).
 */
function shapeMark(x: Node<'float'>): Node<'float'> {
  return smoothstep(-0.34, 0.34, x).mul(2).sub(1)
}

/** A brush field, plus the relief and scale the normal-detail layer needs. */
interface BrushField {
  /** Signed stroke value, roughly [-1, 1]. */
  value: Node<'float'>
  /**
   * Tangential gradient of the relief height field, in 1/metres, BEFORE the
   * per-asset relief amplitude. Analytic, not a screen derivative — see
   * `reliefField`.
   */
  gradient: Node<'vec3'>
  /** The relief height itself, roughly [-1, 1]. Drives the ambient occlusion. */
  height: Node<'float'>
  /**
   * World period of the finest octave, metres. The normal-detail layer needs
   * it: a relief field only has a scale-invariant SLOPE if its amplitude
   * tracks its own wavelength.
   */
  fineScale: Node<'float'>
}

/**
 * World-space gradient of the relief height field, by forward differences.
 *
 * Screen-space derivatives were the obvious way to do this and they cannot work
 * on this geometry. `dFdx(positionWorld)` is constant WITHIN a triangle and
 * jumps ACROSS one, because each triangle is a different plane; any 2x2 quad
 * straddling an edge therefore differentiates across two planes at once and
 * returns garbage. On the greybox ground, 19 m triangles project to ~16 px at
 * mid distance, so roughly a tenth of the frame sat in a straddling quad and the
 * result was a dotted stipple tracing the terrain's triangulation across every
 * hillside — visible in the round-4 captures, and exactly what the structure
 * gate's new speckle term is looking for.
 *
 * Four taps of a plain 3D noise instead (one centre plus three forward
 * differences). The field depends only on world
 * position, so it is C1 everywhere regardless of tessellation, the gradient is
 * basis-independent, and the relief is decoupled from the albedo strokes, which
 * reads better anyway: paint and form do not have to agree stroke for stroke.
 */
function reliefField(
  pw: Node<'vec3'>, n: Node<'vec3'>, s0: Node<'float'>, f: Node<'float'>,
): { gradient: Node<'vec3'>; height: Node<'float'> } {
  // Sampled at the two rungs the albedo ladder is between, and cross-faded on
  // the same fraction, so the relief hands over without popping.
  const field = (p: Node<'vec3'>): Node<'float'> => {
    const a = mx_noise_float(vec3(p.div(s0).add(vec3(37.1, 11.7, 5.3))))
    const b = mx_noise_float(vec3(p.div(s0.mul(2)).add(vec3(3.9, 41.2, 23.6))))
    return mix(a, b, f)
  }
  const e = s0.mul(0.28)
  const h = field(pw)
  const g = vec3(
    field(vec3(pw.add(vec3(e, 0, 0)))).sub(h),
    field(vec3(pw.add(vec3(0, e, 0)))).sub(h),
    field(vec3(pw.add(vec3(0, 0, e)))).sub(h),
  ).div(e)
  // Only the component in the surface plane tilts the normal.
  return { gradient: vec3(g.sub(n.mul(dot(g, n)))), height: h }
}

/**
 * Triplanar projection of the stroke pattern, on a screen-size LOD ladder.
 * Seamless on any topology, present at every range.
 *
 * `dFdx/dFdy` of the world position give metres-per-pixel on this surface right
 * here, which folds distance AND grazing angle into one number — a plain
 * camera distance gets the grazing case wrong, and grazing is most of a
 * landscape frame. From that, `lod` is how many octaves up from `scale` the
 * finest non-aliasing octave sits; the fractional part cross-fades so the
 * ladder is continuous across the whole depth of the frame.
 *
 * Every octave is a world-space function. Only the CHOICE of octave depends on
 * the camera, and it hands over smoothly, so the pattern is surface-locked:
 * move the camera and the strokes stay stuck to the ground.
 */
function triplanarBrush(scale: Node<'float'>): BrushField {
  const pw = vec3(positionWorld)
  const a = vec3(normalWorld.abs())
  const w = vec3(pow(a.x, 4), pow(a.y, 4), pow(a.z, 4))
  const wsum = w.x.add(w.y).add(w.z).add(1e-4)
  const wx = w.x.div(wsum)
  const wy = w.y.div(wsum)
  const wz = w.z.div(wsum)
  const octave = (s: Node<'float'>, spin: Node<'float'>): Node<'float'> => {
    const q = vec3(pw.div(s))
    return shapeMark(brushStroke(vec2(q.z, q.y), spin)).mul(wx)
      .add(shapeMark(brushStroke(vec2(q.x, q.z), spin)).mul(wy))
      .add(shapeMark(brushStroke(vec2(q.x, q.y), spin)).mul(wz))
  }

  // Metres per screen pixel on this surface. Clamped against `dist` because at
  // a silhouette the two derivatives straddle a depth discontinuity and come
  // back enormous — unclamped, that put the edge pixels several octaves up the
  // ladder and stitched a dotted sparkle along every ridge line.
  const dist = pw.sub(cameraPosition).length()
  const texel = dFdx(pw).length().max(dFdy(pw).length())
    .min(dist.mul(0.022)).max(1e-5)
  const lod = log2(texel.mul(STROKE_PX).div(scale.max(1e-3))).max(0)
  const rung = floor(lod)
  const f = lod.sub(rung)
  const s0 = scale.mul(exp2(rung))
  const o0 = octave(s0, rung.mul(SPIN_STEP))
  const o1 = octave(s0.mul(2), rung.add(1).mul(SPIN_STEP))
  const o2 = octave(s0.mul(4), rung.add(2).mul(SPIN_STEP))
  // Two bands sharing three evaluations. Each band cross-fades one rung up as
  // `f` runs 0->1, so at the handover band k is exactly what band k-1 was and
  // nothing pops.
  const band0 = mix(o0, o1, f)
  const band1 = mix(o1, o2, f)
  const macro = octave(scale.mul(MACRO_STEP), float(1.9))
  const value = band0.mul(0.40)
    .add(band1.mul(0.32))
    .add(macro.mul(0.28))
    .mul(BRUSH_GAIN)
  const relief = reliefField(pw, vec3(normalWorld), s0, f)
  return { value, gradient: relief.gradient, height: relief.height, fineScale: s0 }
}

/**
 * Tilt the geometric normal by a tangential relief gradient.
 *
 * Nothing is displaced: this is a normal-only detail layer, and against a 3-stop
 * ramp it buys far more than its cost, because a small tilt near a ramp
 * threshold flips a whole patch onto the next authored colour. That is exactly
 * the small, hard-edged painterly facetting the references carry on every
 * hillside, and ART_BIBLE §2's "detail lives in the light, not the geometry"
 * taken literally.
 *
 * `gradient` is in 1/metres; multiplying by the field's own wavelength turns it
 * into a dimensionless slope, which is the scale-invariant quantity. Without
 * that the relief would flatten out with distance.
 */
function bumpNormal(
  geoN: Node<'vec3'>, gradient: Node<'vec3'>, relief: Node<'float'>,
): Node<'vec3'> {
  const g = vec3(gradient.mul(relief))
  // Capped, so an extreme sample cannot invert the normal.
  const capped = vec3(g.mul(float(1.0).div(g.length().max(1.0))))
  return vec3(normalize(geoN.sub(capped)))
}

/**
 * A live instance of the shared material. Params are uniforms, so the Forge and
 * the in-game inspector will be able to drive them without a recompile.
 */
export class PainterlyMaterial {
  readonly material = new THREE.MeshBasicNodeMaterial()
  readonly params: PainterlyParams

  private readonly u = {
    base: uniform(new THREE.Vector3()),
    shadow: uniform(new THREE.Vector3()),
    lit: uniform(new THREE.Vector3()),
    top: uniform(new THREE.Vector3(1, 1, 1)),
    topGain: uniform(1),
    gradientBase: uniform(0),
    gradientHeight: uniform(1),
    gradientStrength: uniform(0),
    rampShadow: uniform(0),
    rampMid: uniform(0.5),
    rampSoftness: uniform(0.2),
    midLevel: uniform(0.55),
    brushStrength: uniform(0.5),
    brushScale: uniform(3),
    brushSaturation: uniform(0.5),
    detailStrength: uniform(0.55),
    reliefShade: uniform(0.6),
    rimStrength: uniform(0.5),
    rimPower: uniform(3),
    saturationGain: uniform(0.4),
    shadowSkyTint: uniform(0.5),
    ambient: uniform(1),
  }

  constructor(atmosphere: Atmosphere, params: Partial<PainterlyParams> = {}) {
    this.params = { ...PAINTERLY_DEFAULTS, ...params }
    const u = this.u
    const geoN = vec3(normalWorld)

    // ── brush field, and the micro-relief read off it ────────────────────────
    // Evaluated FIRST because the shading normal depends on it. One field feeds
    // both the albedo strokes and the relief, so a stroke's colour and its form
    // agree — which is what a loaded brush actually does to a surface, and what
    // separates this from a noise overlay sitting on top of clean shading.
    const brush = triplanarBrush(u.brushScale)
    const stroke = brush.value.mul(u.brushStrength)
    const n = bumpNormal(geoN, brush.gradient, u.detailStrength.mul(brush.fineScale))

    // ── 3-stop diffuse ramp (not raw N.L) ────────────────────────────────────
    // The cast shadow is folded into the ramp INPUT, not multiplied onto the
    // direct term afterwards. That matters: a sun-facing slope in shadow has to
    // pick the authored SHADOW colour (a teal-green for grass), not keep the lit
    // lime and merely lose its key. Driving the ramp is what makes the cast
    // shadow coloured rather than just darker.
    const ndotl = dot(n, atmosphere.nodes.sunDir)
    const vis = atmosphere.sunVisibility(vec3(positionWorld))
    // Thresholds track the sun's height. See `rampScale` in tod.ts: compared
    // against a raw N.L, an absolute 0.30 shadow threshold puts EVERY surface
    // in a golden-hour frame on the shadow stop, because the largest N.L
    // available at a 7deg sun is 0.12.
    // The two steps do NOT scale by the same amount, and that asymmetry is the
    // whole trick. The SHADOW step has to track the sun all the way down, or
    // level ground — which is most of the frame — sits on the shadow stop at
    // dusk and the foreground is a formless slab. The LIT step must not: at a
    // low sun the N.L available across a hilly landscape spans the full 0..1,
    // so scaling that threshold too makes every slope within ~10deg of the sun
    // go to the LIT stop at once and the frame blows to fluorescent yellow.
    // Lit stays a high, rare bar; only genuinely sun-facing faces reach it.
    const scaleLow = atmosphere.rampScaleNode
    // 0.22, down from 0.45. The LIT stop is meant to be a rare, high bar, and at
    // a raking sun the 0.45 blend dropped its threshold to N.L 0.54 — so on a
    // hilly vista every slope within ~30deg of the sun jumped to the lit lime at
    // once, right beside a slope on the shadow stop. That produced local contrast
    // 1.7x the reference band (greybox-dusk medStd 0.115 against 0.056-0.080) and
    // read as fluorescent confetti rather than as raking light.
    const scaleHigh = mix(float(1), scaleLow, 0.22)
    // The ramp's SOFTNESS is only half-scaled, and the thresholds fully.
    //
    // Scaling both by `rampScale` made the terminator razor-sharp at low sun:
    // at a 7deg sun `meadow` compared N.L against 0.042 with a half-width of
    // 0.021, so every undulation in the terrain crossed the whole step within a
    // couple of degrees of slope and the vista became a mass of hard edges —
    // greybox-dusk measured 1.4x the reference band of local contrast with cast
    // shadows almost entirely disabled, so the edges were the ramp itself, not
    // the shadow map.
    //
    // Physically it should go the other way: a low sun is filtered through ten
    // air masses and is a markedly SOFTER, more diffuse key than a high one, so
    // its terminator is wider, not narrower. Holding softness back toward its
    // authored width restores that.
    const softScale = mix(float(1), scaleLow, 0.55)
    const softLow = u.rampSoftness.mul(softScale)
    const softHigh = u.rampSoftness.mul(mix(float(1), scaleHigh, 0.55))
    const litMid = smoothstep(
      u.rampShadow.mul(scaleLow).sub(softLow), u.rampShadow.mul(scaleLow).add(softLow), ndotl,
    )
    const litTop = smoothstep(
      u.rampMid.mul(scaleHigh).sub(softHigh), u.rampMid.mul(scaleHigh).add(softHigh), ndotl,
    )
    // Occlusion multiplies the ramp instead of being folded into its INPUT.
    //
    // Round 2 did `shaded = mix(-1, N.L, vis)`, which looks equivalent and is
    // not: it makes the visible transition a function of where `vis` crosses
    // the ramp's own thresholds, so the ramp AMPLIFIES the penumbra's gradient
    // — a lit slope at N.L 0.9 has its whole shadow edge compressed into vis
    // 0.53..0.84, i.e. three of the PCF's discrete levels. That is why the
    // cascade upgrade alone still left a hard, aliased terminator. Multiplying
    // makes the transition LINEAR in `vis`, so the PCF kernel's softness
    // reaches the screen at full width, and a fully occluded surface still
    // picks the authored SHADOW stop rather than merely losing its key.
    const toMid = litMid.mul(vis)
    const toLit = litTop.mul(vis)

    // ── ambient: the sky irradiance LUT, and nothing else ────────────────────
    // Modulated by the relief's HEIGHT as well as its normal, which is the half
    // of micro-relief shading that survives when there is no key light at all.
    //
    // A tilted facet only reads if the light it is tilting toward and away from
    // differ. In full shade — every surface in a horizon-sun frame, and the
    // anti-solar side of every hill at golden hour — the ramp is pinned on its
    // shadow stop and the normal buys nothing, which is why those frames stayed
    // formless after the normal layer went in. Height does buy something there:
    // a raised stroke sees more sky than the hollow beside it. It is the
    // cheapest possible ambient occlusion (the field is already computed for the
    // gradient) and it is the term that gives a shadow mass internal modelling
    // rather than leaving it a flat slab.
    const reliefAO = brush.height.mul(u.reliefShade).add(1).max(0.2)
    const ambient = vec3(atmosphere.skyIrradiance(n)
      .mul(atmosphere.ambientGainNode).mul(u.ambient).mul(reliefAO))
    // The sky's hue at unit luminance — what "tinted toward the sky" means.
    const skyHue = vec3(ambient.div(luminance(ambient).max(1e-4)))

    // ── albedo: three authored colours, selected by the ramp ──────────────────
    const shadowStop = vec3(mix(
      u.shadow,
      boostSaturation(vec3(skyHue.mul(luminance(u.shadow))), 1.2),
      saturate(u.shadowSkyTint.mul(atmosphere.shadowTintBoostNode)),
    ))
    let albedo: Node<'vec3'> = vec3(mix(shadowStop, u.base, toMid))
    albedo = vec3(mix(albedo, u.lit, toLit))

    // ── vertical gradient along the object up-axis ────────────────────────────
    const rise = saturate(positionLocal.y.sub(u.gradientBase).div(u.gradientHeight.max(1e-3)))
    albedo = vec3(mix(albedo, albedo.mul(u.top).mul(u.topGain), rise.mul(u.gradientStrength)))

    // ── triplanar brush overlay: value + a little saturation ──────────────────
    // Value down-modulation only on the negative side is deliberate: strokes
    // that only ever brighten push the whole surface toward white, which is how
    // round 1 ended up with a single highlighter-lime wash.
    // Floored at 0.12 rather than allowed to reach zero: now that the field
    // carries real amplitude a -1.4 tail would multiply the albedo negative and
    // clamp to black, which is a hole in the surface, not a brush mark.
    albedo = vec3(setSaturation(
      vec3(albedo.mul(stroke.mul(0.72).add(1).max(0.12))),
      stroke.mul(u.brushSaturation).mul(0.75).add(1).max(0.15),
    ))

    // ── light: sky ambient (coloured, lifted) + ramped direct ─────────────────
    const level = mix(float(0), u.midLevel, toMid)
    const direct = vec3(atmosphere.sunColorNode.mul(mix(level, float(1), toLit)))
    let color: Node<'vec3'> = vec3(albedo.mul(ambient.add(direct)))

    // ── soft sky-coloured rim ────────────────────────────────────────────────
    // Weighted by the surface's OWN reflectance, and that is a bug fix, not a
    // refinement.
    //
    // The rim was a flat additive wash of sky irradiance gated only on
    // view-normal angle. That is the right shape for a bush or a raccoon, whose
    // grazing band is a thin sliver next to its silhouette, and completely wrong
    // for terrain: a camera 14 m up looking down 9 degrees sees the ground at
    // grazing incidence across the ENTIRE frame, so `rim` saturated at
    // rimStrength everywhere. The meadow's shadow stop has linear luminance
    // 0.114 and was being handed 0.204 of unmodulated ambient on top — the wash
    // was 1.8x the surface it was rimming. Sixty-four percent of every low-sun
    // pixel was one constant, which is why atmos-sunrise-sunward measured a
    // 1% value spread over a 48 px tile and why a 3.6x stronger brush moved it
    // by almost nothing: the brush was in the 36% that still varied.
    //
    // Scaling by the albedo's own luminance bounds the term by the thing it is
    // lighting, and — because `albedo` already carries the brush — the rim now
    // carries the stroke pattern instead of erasing it. It stays sky-COLOURED,
    // which is the part ART_BIBLE §3 actually asks for.
    const view = vec3(cameraPosition.sub(positionWorld).normalize())
    const rim = pow(saturate(dot(n, view).oneMinus()), u.rimPower).mul(u.rimStrength)
    const rimWeight = saturate(luminance(albedo).mul(2.6))
    color = vec3(color.add(ambient.mul(rim).mul(rimWeight).mul(0.85)))

    // ── saturation rises with luminance (ART_BIBLE §2) ────────────────────────
    const lum = luminance(color)
    color = gradeSaturation(color, u.saturationGain.mul(smoothstep(0.03, 0.7, lum)).add(1))

    // ── aerial perspective, in-shader ────────────────────────────────────────
    this.material.colorNode = atmosphere.aerialPerspective(color, vec3(positionWorld), stroke)
    this.material.name = 'painterly'
    this.set(this.params)
  }

  /** Push params into the uniforms. No recompile. */
  set(patch: Partial<PainterlyParams>): void {
    Object.assign(this.params, patch)
    const p = this.params
    const u = this.u
    hexToLinear(p.base, u.base.value)
    hexToLinear(p.shadow, u.shadow.value)
    hexToLinear(p.lit, u.lit.value)
    hexToLinear(p.top, u.top.value)
    u.topGain.value = p.topGain
    u.gradientBase.value = p.gradientBase
    u.gradientHeight.value = p.gradientHeight
    u.gradientStrength.value = p.gradientStrength
    u.rampShadow.value = p.rampShadow
    u.rampMid.value = p.rampMid
    u.rampSoftness.value = p.rampSoftness
    u.midLevel.value = p.midLevel
    u.brushStrength.value = p.brushStrength
    u.brushScale.value = p.brushScale
    u.brushSaturation.value = p.brushSaturation
    u.detailStrength.value = p.detailStrength
    u.reliefShade.value = p.reliefShade
    u.rimStrength.value = p.rimStrength
    u.rimPower.value = p.rimPower
    u.saturationGain.value = p.saturationGain
    u.shadowSkyTint.value = p.shadowSkyTint
    u.ambient.value = p.ambient
  }
}
