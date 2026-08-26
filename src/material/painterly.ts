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
import {
  boostSaturation, clampChroma, flatMark, gradeSaturation, rotateHue, setSaturation,
} from '../atmosphere/scattering'

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
   * Hue swing of one brush mark, RADIANS at full stroke.
   *
   * The axis the brush overlay was missing. `albedo * (stroke*0.72+1)` inside
   * `setSaturation` moves VALUE and SATURATION and nothing else, so adjacent
   * marks came out as the same colour at two brightnesses. Measured, the
   * circular standard deviation of hue in the near-field foreground was 14.4deg
   * against 41.3 in genshin/grasslands, 53.9 in capycastaway/water-lagoon and
   * 82.6 in painterly/cliffs-tohad: in the references adjacent marks are
   * different COLOURS.
   *
   * Driven from the RELIEF field rather than from the stroke field, so the hue
   * boundaries do not sit on top of the value boundaries — a painter reloading
   * with a slightly different mix does not change colour exactly where the
   * value changes. 0.26 rad = 15deg on the meadow, which reads as yellow-green
   * against blue-green.
   */
  brushHue: number
  /**
   * How far the coarse region mask shifts the ramp thresholds, in units of
   * `rampSoftness`. See `region` in `BrushField`.
   *
   * 1.0 means the two sides of a region boundary sit a full transition width
   * apart, so wherever the surface is anywhere near a ramp step the patch snaps
   * onto one authored stop or the next as a flat mass with a hard edge. 0 turns
   * the mechanism off and the material is back to a sum of soft octaves.
   */
  regionStep: number
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
  brushHue: 0.26,
  regionStep: 0.52,
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
 * 13 px. Not 8, which put the relief normal's turnover at four pixels and
 * stippled every ridge; and not 20, which was chosen while the mark was a soft
 * lobe. Now that `shapeMark` is a real threshold the two numbers interact: a
 * boundary is a fixed couple of pixels wide, so the mark's PERIOD sets how much
 * of the surface reads as edge rather than as interior. At 20 px the output
 * carried 4x-downsample coherence 0.92-0.97 against a reference band of
 * 0.75-0.94 — the variation was surviving a 4x reduction almost intact, i.e. it
 * was low-frequency form rather than stroke-scale brushwork. A stroke in
 * cliffs-tohad is 15-40 px at 1200 px wide, which is 20-53 px at our 1600, but
 * those are the LARGEST marks in the picture and there is finer work inside
 * them; the macro octave covers that end of the range and this number should
 * cover the other.
 */
const STROKE_PX = 13

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
 * 0.36, down from 1.03, and the change is a direct consequence of `shapeMark`
 * becoming a real step. A stepped octave is BIMODAL: its samples sit at +/-1
 * rather than spreading with the noise's own sigma, so the same weights now
 * produce a composite around sigma 0.6 instead of 0.055 — eleven times the
 * amplitude, which is confetti, and well past the structure gate's ceiling.
 *
 * What the number is set by: the mark contrast needed for a real EDGE. A step
 * across a mark boundary changes the albedo by 2 x gain x brushStrength x 0.72,
 * and display luma responds at roughly (1/2.2) of the relative linear change, so
 * landing meadow's boundaries near the references' |grad luma| ~0.12 at a
 * display level of ~0.6 wants a linear step of ~0.44, i.e. a composite sigma near
 * 0.21. 0.36 x (the ~0.6 the stepped weights give) is that. Because a stepped
 * field is bounded — the three weights sum to exactly 1, so |value| <= 1 — this
 * also removes the long tails the smooth version had, and with them the albedo
 * floor's clamping.
 *
 * Note the asymmetry with the OLD number: the same measured amplitude now buys
 * far more edge, because a bimodal field puts all of its variation at its
 * boundaries instead of spreading it smoothly across the mark.
 */
const BRUSH_GAIN = 0.52

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
 * projected size, so paying for it twice bought nothing. `triplanarBrush`
 * evaluates three ladder rungs (shared across TWO cross-faded bands) plus one
 * macro octave, i.e. 12 triplanar taps, and the relief layer adds 4 more: 16
 * noise evaluations per fragment, down from the previous 18.
 */
function brushStroke(p: Node<'vec2'>, rung: Node<'float'>): Node<'float'> {
  // Every octave is turned by its own angle. Without this every octave
  // squashes along the same axis and they stack into long parallel streaks — the
  // surface reads as combed fur, not as brushwork. The angle is a function of
  // the octave's ABSOLUTE rung, not its index in the ladder, so it survives the
  // LOD handover: rung n's octave has the same orientation whether it is being
  // used as band 0's top or band 1's bottom.
  const spin = rung.mul(SPIN_STEP)
  const c = cos(spin)
  const s = sin(spin)
  // Three more things vary per rung, and they are the fix for the "paisley".
  //
  // Until this round the ONLY thing that changed between octaves was the
  // rotation: every mark in the build was one `mx_noise_float` tap squashed 0.36
  // on the same axis through the same z-slice, so every stamp in every frame was
  // the same silhouette at a different size and angle. At 1:1 that reads as
  // wallpaper — the same comma/teardrop glyph tiling the whole lower frame — and
  // it was the loudest "this is procedural" tell left in the picture.
  //
  //   squash  0.30..0.66  how elongated the mark is across its own axis
  //   shear   +/-0.35     how much it leans, INDEPENDENT of the rotation, so a
  //                       long mark and a fat one at the same angle are still
  //                       different shapes rather than the same one turned
  //   slice   3.7 / rung  a different z-plane of the 3D gradient noise, which
  //                       is a genuinely different field, not a transform of
  //                       the same one
  //
  // All three are functions of the ABSOLUTE rung for the same reason the spin
  // is, and all three are free: no extra noise taps, just different arguments
  // to the one that was already there.
  const squash = float(0.48).add(sin(rung.mul(2.399)).mul(0.18))
  const shear = sin(rung.mul(1.771)).mul(0.35)
  const slice = rung.mul(3.7)
  const qx = p.x.mul(c).sub(p.y.mul(s))
  const qy = p.x.mul(s).add(p.y.mul(c))
  return mx_noise_float(vec3(qx.add(qy.mul(shear)), qy.mul(squash), slice))
}

/**
 * A flat-topped mark rather than a smooth blob — and, since this round, actually
 * one. See `flatMark` in scattering.ts.
 *
 * The version that shipped for four rounds was `smoothstep(-0.34, 0.34, x)` on a
 * raw `mx_noise_float` tap. That is not a step, it is a gain of about 4.4x: the
 * tap's standard deviation is ~0.17, so over 99% of samples land INSIDE the
 * transition band and never reach either flat end. Every mark came out as a soft
 * noise lobe with no boundary anywhere, which is why the frames measured 4-7x
 * fewer luma edges than refs/ while still landing inside the per-tile variance
 * band the structure gate measures. Variance cannot separate a 40 px soft blob
 * from a brush mark; edge density can, and it is now reported by
 * tools/structure.mjs so the next round can see it.
 *
 * Aliased to the shared helper rather than duplicated because the sky dome's
 * brush had the identical bug and needs the identical fix.
 */
const shapeMark = flatMark

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
  /**
   * HARD region mask, ~[-1, 1] and bimodal, at roughly 100 screen pixels.
   *
   * Not another addend. This is the fix for the thing that made every surface
   * read as airbrush no matter how hard the fine octaves were stepped: a
   * weighted SUM of three stepped fields whose boundaries land in three
   * different places can never be flat anywhere and can never make a
   * full-height jump anywhere. Measured on the previous build, the lower 28% of
   * shots/near-noon.png had 1.1% of its pixels inside a 5x5 patch flat to within
   * 0.010 luma, against 7.8-38.8% across the references, while its MEDIAN
   * gradient ran 1.4-3.2x the references and its 99th percentile ran half
   * theirs. More wobble everywhere and less contrast anywhere is the numeric
   * signature of an airbrush.
   *
   * So the coarse octave stops being a value addend and becomes a SELECTOR: it
   * shifts the lighting ramp's thresholds across a whole patch, so the patch
   * lands on the next authored colour stop as one flat mass with one boundary
   * around it. That is what a loaded flat brush does, and it is the only
   * mechanism in the material that can produce a plateau and a full-amplitude
   * edge at the same time.
   */
  region: Node<'float'>
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
  const octave = (
    s: Node<'float'>, rung: Node<'float'>, half = 0.13,
  ): Node<'float'> => {
    const q = vec3(pw.div(s))
    return shapeMark(brushStroke(vec2(q.z, q.y), rung), half).mul(wx)
      .add(shapeMark(brushStroke(vec2(q.x, q.z), rung), half).mul(wy))
      .add(shapeMark(brushStroke(vec2(q.x, q.y), rung), half).mul(wz))
  }

  // Metres per screen pixel on this surface. Clamped against `dist` because at
  // a silhouette the two derivatives straddle a depth discontinuity and come
  // back enormous — unclamped, that put the edge pixels several octaves up the
  // ladder and stitched a dotted sparkle along every ridge line.
  const dist = pw.sub(cameraPosition).length()
  const texel = dFdx(pw).length().max(dFdy(pw).length())
    .min(dist.mul(0.022)).max(1e-5)
  // Floored at -4, not at 0, and that clamp was a bug rather than a safety rail.
  //
  // `.max(0)` makes STROKE_PX a CEILING with no floor: the ladder can climb to
  // coarser octaves at distance but can never descend below the authored
  // `brushScale`, so anything nearer than one stroke-width of it gets a single
  // giant blob. At a gameplay camera the near ground wants marks around 0.05 m
  // to project at 20 px, while `meadow` authors 3.6 m — six rungs away — so the
  // whole near field came out as 60-200 px of soft green camo, all the same size
  // and all combed the same diagonal. That is the worst surface in the build and
  // it is the one the player's own camera is pointed at.
  //
  // Descending is safe BY CONSTRUCTION, which is the point of selecting by
  // projected size: whatever rung is chosen, its period on screen is ~STROKE_PX,
  // so a finer octave can never alias — the aliasing risk is a world-locked
  // octave FIXED too fine, which is what the ladder exists to avoid. -4 gives
  // meadow a 0.22 m finest mark, which covers a 3.5 m camera down to a couple of
  // metres, and keeps the authored scale meaningful at vista range.
  const lod = log2(texel.mul(STROKE_PX).div(scale.max(1e-3))).max(-4)
  const rung = floor(lod)
  const f = lod.sub(rung)
  const s0 = scale.mul(exp2(rung))
  const o0 = octave(s0, rung)
  const o1 = octave(s0.mul(2), rung.add(1))
  const o2 = octave(s0.mul(4), rung.add(2))
  // Two bands sharing three evaluations. Each band cross-fades one rung up as
  // `f` runs 0->1, so at the handover band k is exactly what band k-1 was and
  // nothing pops.
  const band0 = mix(o0, o1, f)
  const band1 = mix(o1, o2, f)
  // The coarse rung. Three rungs above the finest, so ~8 x STROKE_PX ~= 100
  // screen pixels — the size of the flat masses the references break a hillside
  // into, and the size the critique measured our plateaus as needing to be.
  //
  // It replaces the old `macro` octave, which was a fixed 24 x brushScale in
  // WORLD units (86 m on the meadow) and therefore covered the whole frame at a
  // gameplay camera and a few pixels at vista range. Selecting it off the same
  // ladder as everything else keeps its projected size constant, which is the
  // property the whole ladder exists for. Same tap count as before: this octave
  // is paid for by the macro one it replaces.
  //
  // Stepped much harder than the paint octaves (0.05 sigma against 0.13): this
  // one is a region mask, and a region either is or is not.
  const region = mix(
    octave(s0.mul(8), rung.add(3), 0.05),
    octave(s0.mul(16), rung.add(4), 0.05),
    f,
  )
  // Renormalised, because the coarse octave has left the sum. Two stepped,
  // decorrelated fields at 0.44/0.36 carry the same composite sigma the three
  // at 0.40/0.32/0.28 did, so `brushStrength` keeps the meaning its docstring
  // gives it and the structure gate's medStd band is unmoved.
  const value = band0.mul(0.44)
    .add(band1.mul(0.36))
    .mul(BRUSH_GAIN)
  const relief = reliefField(pw, vec3(normalWorld), s0, f)
  return {
    value, gradient: relief.gradient, height: relief.height, fineScale: s0, region,
  }
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
    brushHue: uniform(0.26),
    regionStep: uniform(0.52),
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
    // The coarse region mask, converted into a shift of the ramp's INPUT.
    //
    // Offsetting N.L rather than the two thresholds separately is deliberate:
    // it moves the whole 3-stop ramp for that patch by one amount, so a region
    // reads as "this whole mass is one step further into the light / into the
    // shade" rather than as two independent boundaries that can land in
    // different places. Scaled by the ramp's own softness so it means the same
    // thing at every authored cel-hardness.
    const regionShift = brush.region.mul(u.rampSoftness).mul(u.regionStep).toVar()
    const ndotl = dot(n, atmosphere.nodes.sunDir).add(regionShift)
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
    // The shadow step gets an extra multiplier at a high sun — see
    // `rampShadowGain` in tod.ts. Without it the noon frames never select the
    // shadow stop at all and the bottom half of the value range is unused.
    const scaleLow = atmosphere.rampScaleNode
    const scaleShadow = scaleLow.mul(atmosphere.rampShadowGainNode)
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
    const shadowT = u.rampShadow.mul(scaleShadow).toVar()
    const litMid = smoothstep(shadowT.sub(softLow), shadowT.add(softLow), ndotl)
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
    // Stepped, like the albedo marks, and for the same reason. This term is a
    // smooth noise field multiplying the ambient at +/-50%, so on a bright frame
    // it is one of the largest signals on the surface — and a soft gradient here
    // washes out hard-edged marks underneath it no matter how crisp they are.
    // The near ground read as airbrushed green camouflage largely because of
    // this layer. A patch of shade with an edge is also the more painterly
    // object: the references' hillsides are made of flat masses, not of haze.
    //
    // The relief's GRADIENT stays smooth — see `bumpNormal`. Only the occlusion
    // is thresholded, because a stepped gradient would fold a discontinuity into
    // the shading normal and stipple every boundary.
    // 0.26, not 0.55: a stepped field is bimodal, so the same nominal amplitude
    // puts every dark patch at the FULL depth instead of spreading a Gaussian
    // over it, and the darkest fifth of the near-field frames fell to Rec.709
    // luma 0.25-0.29 against the 0.299 floor tools/shadow.mjs sets off the
    // references. Patches with edges, at a shallower depth.
    // Half-width 0.55 sigma rather than the albedo's 0.13: a patch with an edge,
    // but a softer edge than a paint mark has. This term drives the ambient, and
    // a razor boundary in the FILL lands on top of every ramp terminator in the
    // frame — on a hard-edged prop that reads as a chewed silhouette, not as a
    // brush stroke.
    const reliefAO = flatMark(brush.height, 0.55).mul(u.reliefShade.mul(0.26)).add(1).max(0.2)
    // Held in a variable. The ambient is read by the shadow stop, the light sum
    // and the rim, and TSL re-emits an expression's whole subtree on every read
    // — see `clampChroma` in scattering.ts for what that cost when it went
    // unnoticed. This is one texture fetch and one hue rotation, not four.
    const ambient = vec3(atmosphere.skyIrradiance(n)
      .mul(atmosphere.ambientGainNode).mul(u.ambient).mul(reliefAO)).toVar()
    // The sky's hue at unit luminance — what "tinted toward the sky" means.
    //
    // Clamped, because "at unit luminance" is where the dawn frames went wrong.
    // Rec.709 weights blue at 0.0722, so dividing a near-pure-blue ambient by
    // its own luminance returns a blue channel ~2.7x larger than 1 — and that
    // number then multiplies the shadow stop's luminance and becomes the shadow
    // ALBEDO. The authored green grass shade came out navy, and because HSV
    // value is the peak channel, the whole frame's value range went with it. The
    // reference shade keeps the albedo's own hue with a cool cast: grasslands'
    // grass shadow is hue 124, still green. `ambientChroma` is tighter than the
    // fill's own cap for the same reason the docstring on `shadowSkyTint` gives
    // — the references cool their shade, they do not recolour it.
    const skyHue = vec3(ambient.div(luminance(ambient).max(1e-4))).toVar()

    // ── albedo: three authored colours, selected by the ramp ──────────────────
    // The sky-hued alternative to the authored shadow colour, at the SAME
    // luminance so the rotation costs no lightness — then chroma-capped, which
    // is the fix for the navy shade. See `clampChroma` in scattering.ts: the
    // unit-luminance normalisation above hands back a blue channel up to 2.7x
    // its own luminance at dawn, `boostSaturation` widens that further, and the
    // product with `shadowSkyTint` x `shadowTintBoost` (0.18 x 3.2 = 0.58 at a
    // horizon sun) puts most of that into the shadow albedo. Capping the ratio
    // keeps the shade unmistakably sky-tinted and stops it being single-channel.
    const skyShadow = clampChroma(
      boostSaturation(vec3(skyHue.mul(luminance(u.shadow))), 1.2),
      atmosphere.ambientChromaNode,
    )
    const shadowStop = vec3(mix(
      u.shadow,
      skyShadow,
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
    // ── and a HUE axis, from a source decorrelated from the value one ─────────
    // See `brushHue`. The relief height is already computed four times per
    // fragment for the normal layer, so this costs one hue rotation and nothing
    // else, and because it is a different field from `stroke` the colour
    // boundaries do not sit on top of the value boundaries.
    // Stepped, like the marks themselves, and NOT scaled by `brushStrength`.
    // A smooth rotation the size of the relief field's own sigma (~0.17) moved
    // the near field's circular hue std from 14.4deg to only 20.3deg against
    // 34-74deg across the references: a gradual hue drift reads as one colour
    // that wanders, where a painting has two colours meeting at an edge. Pushed
    // through the same threshold the paint marks use, `brushHue` becomes what
    // its docstring says — the hue difference BETWEEN adjacent marks — and it
    // is a per-surface authored angle rather than something the value knob
    // drags around with it.
    albedo = rotateHue(albedo, flatMark(brush.height, 0.30).mul(u.brushHue))

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
    // Weighted by the albedo ITSELF, not by its luminance, and that is the
    // second half of the same bug fix.
    //
    // Scaling a sky-coloured wash by `luminance(albedo)` bounds its SIZE by the
    // surface but leaves its HUE untouched, so on a grazing view — which is the
    // whole frame from a 3.5 m camera — every shaded pixel received a large
    // additive dose of raw sky. Measured on shots/near-dusk.png that put the
    // shaded near ground at hue 225-237 with green at 0.51 of the peak channel,
    // i.e. indigo, against hue 173-191 and green at 0.85-1.00 of peak in every
    // reference's darks. ART_BIBLE §2 is explicit that the references "cool
    // their shade, they do not recolour it" — grasslands' grass shadow is still
    // GREEN at hue 124 — and a wash that carries none of the albedo's own
    // colour cannot obey that rule at any strength.
    //
    // Multiplying by the albedo makes the term what it physically is: more of
    // the sky reflected by THIS surface at a grazing angle. It stays
    // sky-COLOURED (the ambient is the sky irradiance LUT) without overwriting
    // the material's identity, it still carries the brush, and because the
    // authored `lit` stops are far brighter than the `shadow` stops it now
    // reads strongest exactly where a rim should — on the bright side of a
    // silhouette rather than across a shadow mass.
    const view = vec3(cameraPosition.sub(positionWorld).normalize())
    const rim = pow(saturate(dot(n, view).oneMinus()), u.rimPower).mul(u.rimStrength)
    color = vec3(color.add(albedo.mul(ambient).mul(rim).mul(1.5)))

    // ── chroma FALLS with luminance (ART_BIBLE §2, corrected) ────────────────
    // This previously read `.add(1)`, i.e. saturation multiplier rising from
    // 1.0 to 1+gain as a surface got brighter, per an ART_BIBLE rule that said
    // "saturation increases with light". That rule was measured backwards and
    // has since been corrected in the doc: within a material family the
    // references DESATURATE toward the light.
    //
    //   genshin/grasslands   shaded S0.69 -> lit S0.55   (-0.14)
    //   painterly/cliffs     shaded S0.64 -> lit S0.49   (-0.15)
    //   capycastaway/lagoon  shaded S0.52 -> lit S0.36   (-0.17)
    //
    // A lit surface goes bright and pale-warm; hue warming and value range
    // carry the glow. Multiplying chroma UP on top of that is what produced the
    // acid-green plastic look, and it overrode the per-surface presets no
    // matter what colours those were authored with.
    //
    // `saturationGain` now reads as "fraction of chroma LOST at full light".
    const lum = luminance(color)
    color = gradeSaturation(color, u.saturationGain.mul(smoothstep(0.03, 0.7, lum)).oneMinus())

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
    u.brushHue.value = p.brushHue
    u.regionStep.value = p.regionStep
    u.detailStrength.value = p.detailStrength
    u.reliefShade.value = p.reliefShade
    u.rimStrength.value = p.rimStrength
    u.rimPower.value = p.rimPower
    u.saturationGain.value = p.saturationGain
    u.shadowSkyTint.value = p.shadowSkyTint
    u.ambient.value = p.ambient
  }
}
