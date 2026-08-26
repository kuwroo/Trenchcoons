// Analytic atmospheric scattering, in TSL.
//
// Single-scattering Rayleigh + Mie with a closed-form air-mass approximation
// instead of a ray-marched integral: no loops, so the same expression is cheap
// enough to evaluate per sky pixel, per LUT texel, and 32x per irradiance texel.
//
// The physics gives the STRUCTURE (blue zenith, bright horizon, warm low sun,
// red disc at dusk). A stylisation stage then rotates the result toward the
// palette anchors in tod.ts, because a physically-correct sky is markedly less
// saturated than refs/painterly/cliffs-tohad.jpg. ART_BIBLE §1: painterly, not
// photoreal — hex values are anchors, not law.

import {
  cos, dFdx, dFdy, dot, float, luminance, mix, pow, saturate, sin, smoothstep, vec3,
} from 'three/tsl'
import type { Node, UniformNode, Vector3 } from 'three/webgpu'
import { MIE_G } from './tod'

export type Vec3Uniform = UniformNode<'vec3', Vector3>
export type FloatUniform = UniformNode<'float', number>

/** Uniform bag shared by the sky dome, the sky-view LUT and the irradiance LUT. */
export interface SkyNodes {
  sunDir: Vec3Uniform
  sunTransmittance: Vec3Uniform
  sunAzimuth: Vec3Uniform
  zenithTint: Vec3Uniform
  horizonWarm: Vec3Uniform
  horizonCool: Vec3Uniform
  tauRayleigh: Vec3Uniform
  tauMie: Vec3Uniform
  skyIntensity: FloatUniform
  skyLumGamma: FloatUniform
  skySaturation: FloatUniform
  /** Chroma boost AT THE HORIZON. Much lower than `skySaturation`: the sky
   *  desaturates toward the horizon and the references keep that. */
  skySatHorizon: FloatUniform
  anchorMix: FloatUniform
  sunDiscIntensity: FloatUniform
  cloudLit: Vec3Uniform
  cloudShadow: Vec3Uniform
  cloudCoverage: FloatUniform
  cloudOpacity: FloatUniform
  cloudTime: FloatUniform
}

/**
 * Pull saturation toward the colour's own luminance. Use for DESATURATION
 * (amount < 1) — haze, distance. Clamped, because lerping past a very chromatic
 * colour drives the weakest channel negative.
 */
export function setSaturation(c: Node<'vec3'>, amount: Node<'float'> | number): Node<'vec3'> {
  const l = luminance(c)
  return vec3(mix(vec3(l, l, l), c, amount).max(0))
}

/**
 * Cap how far a colour's PEAK channel may run above its own luminance, at
 * constant luminance.
 *
 * This is the operator the ambient chain was missing, and its absence is what
 * turned the dawn frames into a cobalt-and-magenta poster. Everything that
 * derives a tint from the sky normalises to unit LUMINANCE — `skyHue` in
 * painterly.ts, `ambientWarm` here — and for a deep saturated blue that is a
 * value-exploding operation: Rec.709 gives blue a weight of 0.0722, so a sky
 * whose chromaticity is nearly pure blue comes back with a blue channel roughly
 * 2.7x its luminance. Measured on atmos-sunrise-sunward, the near-field
 * foreground read rgb(73, 58, 193): Rec.709 luma 0.28 (which passes the shadow
 * gate) with HSV value 0.76 (which destroys the value range the palette gate
 * measures, because HSV value IS the peak channel). 95% of that frame sat above
 * value 0.749 and it had no darks at all.
 *
 * The references do not do this. cliffs-tohad's shaded fifth is hue 200 with a
 * peak/luma ratio of 1.37; grasslands' grass shadow is still GREEN at hue 124,
 * ratio ~1.2 — the shade keeps the albedo's own hue with a cool cast, exactly
 * as ART_BIBLE §2 says. Their darks are green- or cyan-dominant, so the channel
 * carrying the value is also the channel carrying the luminance.
 *
 * Mixing toward the grey of the SAME luminance is the minimal fix: luminance is
 * linear, so `mix(grey, c, k)` preserves it exactly while scaling peak-minus-
 * luminance by k. Solving for the k that lands peak at `maxRatio * luminance`
 * gives the tightest chroma that still respects the cap, and `saturate` leaves
 * anything already inside it untouched.
 */
export function clampChroma(c: Node<'vec3'>, maxRatio: Node<'float'> | number): Node<'vec3'> {
  // `toVar()`, and it is load-bearing rather than tidy. TSL builds an expression
  // TREE, not a DAG: every re-read of an argument re-emits the whole subtree that
  // produced it. This operator reads `c` five times, and the thing it is called
  // on is the ambient — itself a texture fetch, a hue rotation, a saturation
  // boost and a directional gain. Written without a variable it took the sky
  // irradiance subtree from one copy to thirty-odd inside the painterly material,
  // the generated WGSL blew up, and the page never reached `__ready` at all (no
  // error, just a compile that never finished). Nothing else in src/ needed this
  // yet because nothing else re-read a node this deep this many times.
  const v = vec3(c).toVar()
  const l = luminance(v).max(1e-5).toVar()
  const peak = v.r.max(v.g).max(v.b)
  const limit = typeof maxRatio === 'number' ? float(maxRatio) : maxRatio
  const k = saturate(limit.sub(1).mul(l).div(peak.sub(l).max(1e-5)))
  return vec3(mix(vec3(l, l, l), v, k))
}

/**
 * Standard deviation of one `mx_noise_float` tap. Measured, not nominal: the
 * nominal range is [-1, 1] and the actual spread is a sixth of that.
 */
export const MARK_SIGMA = 0.17

/**
 * Push a noise tap through a real threshold, so it comes out as a flat-topped
 * mark with a defined boundary instead of a soft lobe.
 *
 * Shared by the surface brush (painterly.ts) and the sky dome's own brush
 * (sky.ts), because they had the same bug: a `smoothstep` whose half-width was
 * two to three times the noise's sigma is not a step at all, it is a gain of
 * about 4x, and 99% of samples never reach either flat end. That is why the
 * frames measured 4-7x fewer luma edges than refs/ while sitting inside the
 * per-tile variance band — a 48 px tile's standard deviation is maximised by
 * soft 40 px blobs just as happily as by paint.
 *
 * `half` is in units of sigma, and 0.13 is the second attempt at it. 0.30 was
 * still too wide to read as paint: a mark whose period is 40 px and whose
 * transition is 6 px of that is a soft-edged blob, and a scanline through the
 * near ground came back as a chain of 8 px ramps with a peak gradient of 0.10
 * per 2 px against 0.16 in refs/genshin/grasslands.jpg. At 0.13 roughly nine
 * tenths of the field saturates and the boundary is as narrow as the screen
 * gradient below will let it be. Gouache lays down a patch of one value and
 * stops; this is the cheapest expression of that.
 *
 * The transition is widened by the field's OWN projected screen gradient, never
 * by a constant: a crisp threshold on a world-locked function is exactly what
 * turns into stipple once the function runs faster than the pixel grid, and one
 * pixel of width is the cheapest correct antialias. Taking the derivative of the
 * noise VALUE is safe where taking it of `positionWorld` is not (see
 * `reliefField` in painterly.ts) — a quad straddling two triangles returns a
 * large derivative rather than a meaningless one, and erring wide only makes a
 * mark soft, while erring narrow makes it alias.
 *
 * The CEILING is relative to the authored width now, and that is a bug fix.
 * At a flat `1.1 * MARK_SIGMA` the guard sat eight times above the authored
 * 0.13, so the derivative term — which the LOD ladder holds at ~0.2-0.5 sigma on
 * EVERY pixel of every frame, not just at silhouettes, because the ladder
 * deliberately keeps one octave period at STROKE_PX — was free to run the full
 * way up. Measured consequence: marks in the near field had a 10-90% rise of
 * 6 px over an 8 px extrema spacing, i.e. three quarters of the half-period was
 * transition and only a quarter was flat. That is a soft lobe with a slightly
 * crisper edge, not the flat-topped mark this function's name promises. Capping
 * the widening at 3x the authored width keeps the silhouette guard (a quad
 * straddling a depth discontinuity still gets three times the smoothing) while
 * leaving the interior of every mark actually flat.
 */
export function flatMark(x: Node<'float'>, half = 0.13): Node<'float'> {
  const w = float(half * MARK_SIGMA)
    .max(dFdx(x).abs().max(dFdy(x).abs()).mul(0.9))
    .min(Math.min(3.0 * half, 1.1) * MARK_SIGMA)
  return smoothstep(w.negate(), w, x).mul(2).sub(1)
}

/**
 * Rotate a linear-RGB colour's hue by `angle` radians, at (approximately)
 * constant luminance.
 *
 * The YIQ rotation matrix, folded into three dot products. Used by the brush
 * overlay: ART_BIBLE's references vary the HUE of adjacent marks, not just
 * their value — circular hue std in the near field of genshin/grasslands is
 * 41deg and of painterly/cliffs-tohad 82deg, against 14deg in our output before
 * this existed. A value-and-saturation-only brush cannot get there at any
 * amplitude, because it only ever produces one colour at several brightnesses.
 *
 * Cheap on purpose — nine multiply-adds, no trig beyond the one sin/cos pair,
 * and no conversion in and out of a polar space. It is not perfectly
 * luminance-preserving for extreme chroma, which is why the caller keeps the
 * angle small.
 */
export function rotateHue(c: Node<'vec3'>, angle: Node<'float'>): Node<'vec3'> {
  const u = cos(angle)
  const w = sin(angle)
  const r = c.r.mul(float(0.299).add(u.mul(0.701)).add(w.mul(0.168)))
    .add(c.g.mul(float(0.587).sub(u.mul(0.587)).add(w.mul(0.330))))
    .add(c.b.mul(float(0.114).sub(u.mul(0.114)).sub(w.mul(0.497))))
  const g = c.r.mul(float(0.299).sub(u.mul(0.299)).sub(w.mul(0.328)))
    .add(c.g.mul(float(0.587).add(u.mul(0.413)).add(w.mul(0.035))))
    .add(c.b.mul(float(0.114).sub(u.mul(0.114)).add(w.mul(0.292))))
  const b = c.r.mul(float(0.299).sub(u.mul(0.300)).add(w.mul(1.250)))
    .add(c.g.mul(float(0.587).sub(u.mul(0.588)).sub(w.mul(1.050))))
    .add(c.b.mul(float(0.114).add(u.mul(0.886)).sub(w.mul(0.203))))
  return vec3(r, g, b).max(0)
}

/**
 * Increase saturation without ever clipping a channel to zero.
 *
 * The obvious operator — lerp away from luminance — is unusable here. Our
 * albedos are already hyper-saturated, so for a lime green (0.83, 1.60, 0.18)
 * with luminance 1.33 even a modest 1.2x sends blue negative, and the result
 * clamps to pure yellow. That is exactly the failure the first pass of this
 * milestone produced.
 *
 * Instead, scale each channel by its own ratio to the peak channel raised to
 * (amount - 1). Monotonic, hue-stable, and structurally incapable of going
 * negative.
 */
export function boostSaturation(c: Node<'vec3'>, amount: Node<'float'> | number): Node<'vec3'> {
  const peak = c.r.max(c.g).max(c.b).max(1e-4)
  const ratio = vec3(c.div(peak)).max(1e-4)
  const k = typeof amount === 'number' ? float(amount - 1) : amount.sub(1)
  return vec3(c.mul(pow(ratio, k.max(0))))
}

/**
 * Saturation boost that ROLLS OFF on colours that are already chromatic.
 *
 * `boostSaturation` is the right operator for pushing a dull physical value
 * toward the reference board, and the wrong one for grading a frame that is
 * already there: it scales the non-peak channels by (ratio)^k, so a pixel whose
 * green sits at 0.19 of its blue loses 74% of its green at k = 0.8. Applied to
 * the sky — the most chromatic thing in frame — that is a ~30 degree hue
 * rotation from cyan-blue into blue-violet, which is exactly what the measured
 * zenith did (hue 234 against the master palette's 203) and, because ambient,
 * haze and every shadow derive from the sky LUT, it took the whole board with
 * it.
 *
 * Weighting the exponent by (1 - existing HSV saturation) makes the operator do
 * what a film LUT does: lift the dull, leave the vivid alone. The frame-wide
 * mean saturation still rises, but no hue moves.
 */
export function gradeSaturation(c: Node<'vec3'>, amount: Node<'float'> | number): Node<'vec3'> {
  const peak = c.r.max(c.g).max(c.b).max(1e-4)
  const low = c.r.min(c.g).min(c.b)
  const chroma = saturate(peak.sub(low).div(peak))
  const ratio = vec3(c.div(peak)).max(1e-4)
  const k = typeof amount === 'number' ? float(amount - 1) : amount.sub(1)
  // A floor under the weight, not a pure rolloff: at zero the operator stops
  // touching the vivid two thirds of a painterly frame and the whole image
  // goes pastel. 0.28 keeps the punch and still caps the hue rotation.
  const weight = float(0.28).add(pow(chroma.oneMinus(), 1.2).mul(0.72))
  return vec3(c.mul(pow(ratio, k.max(0).mul(weight))))
}

/**
 * Relative air mass. Matches `airMass()` in tod.ts exactly so the CPU-side sun
 * colour and the GPU-side sky can never drift apart.
 */
export function airMassNode(cosZenith: Node<'float'>): Node<'float'> {
  return float(1.05).div(cosZenith.max(0).add(0.09))
}

/**
 * Sky radiance for a view direction, WITHOUT the sun disc or clouds.
 * This is the quantity the sky-view LUT stores and that aerial perspective and
 * ambient irradiance both read — one source of truth for "what colour is the
 * air in that direction".
 */
export function skyRadiance(u: SkyNodes, dir: Node<'vec3'>): Node<'vec3'> {
  const h = dir.y

  // Extinction along the view ray, and the fraction of it that scatters in.
  const amView = airMassNode(h)
  const tauTotal = u.tauRayleigh.add(u.tauMie)
  const transView = tauTotal.mul(amView).negate().exp()
  const pathFrac = transView.oneMinus()

  // Phase functions.
  const mu = dot(dir, u.sunDir)
  const phaseR = mu.mul(mu).add(1).mul(0.0596831)
  const g = MIE_G
  const hgDenom = pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5).max(1e-4)
  const phaseM = float((1 - g * g) / (4 * Math.PI)).div(hgDenom)

  // Ratio form: colour comes from which species scatters, brightness from how
  // much of the ray's extinction has happened.
  const scatter = u.tauRayleigh.mul(phaseR).add(u.tauMie.mul(phaseM))
  const physical = vec3(scatter.div(tauTotal).mul(pathFrac).mul(u.sunTransmittance))

  // ── stylisation ────────────────────────────────────────────────────────────
  // Split into luminance and chroma and treat them SEPARATELY, and — new in
  // this round — keep every chroma step luminance-neutral so that `level` is
  // the only thing setting the sky's brightness.
  //
  // That orthogonality is not tidiness, it is the fix for the sky hue. The
  // previous order was `boostSaturation` FIRST, then a hue anchor. But
  // boostSaturation scales the non-peak channels DOWN, so at skySaturation 5.2
  // the zenith's green ratio of 0.51 became 0.51^4.2 = 0.058: the green channel
  // was deleted, and a cyan-blue sky turned blue-violet. Measured zenith came
  // out at hue 234 against the master palette's #3FA9F5 at hue 203, and since
  // ambient, haze, water and every shadow derive from this LUT, the whole board
  // went periwinkle. It also made the sky ~5x darker than `level` says, which
  // is why the knob had to be set so high in the first place.
  //
  // Rotating the CHROMATICITY onto the anchor first, boosting second, and
  // renormalising luminance after both means the anchor's own hue survives.
  const physLum = luminance(physical).max(1e-7)
  const chroma = vec3(physical.div(physLum))
  const level = pow(physLum.mul(u.skyIntensity), u.skyLumGamma)

  // 1. Rotate hue toward the palette anchors.
  //    The horizon anchor is AZIMUTH-AWARE: warm toward the sun, cool away
  //    from it. An elevation-only anchor (round 1, at anchorMix 0.86) discarded
  //    86% of the sky's azimuthal dependence, so sunset became a ring and
  //    aerial perspective — which reads this same LUT — became non-directional.
  const azLen = dir.xz.length().max(1e-4)
  const solar = pow(saturate(dot(dir, u.sunAzimuth).div(azLen)), 1.5)
  const horizonAnchor = mix(u.horizonCool, u.horizonWarm, solar)
  const horizonW = pow(saturate(h.max(0).oneMinus()), 2.6)
  const anchor = mix(u.zenithTint, horizonAnchor, horizonW)
  const hued = normaliseLuminance(vec3(mix(chroma, anchor, u.anchorMix)))
  // 2. Chroma rolloff with elevation.
  //
  // This previously read "undo the physical desaturation toward the horizon"
  // and applied ONE boost across the whole dome. Rayleigh scattering
  // desaturates toward the horizon and the references KEEP that: measured on
  // cliffs-tohad, zenith is H207 S0.83 and the horizon is H242 S0.25 — a 0.58
  // drop. Undoing it pinned our dome at S0.86 zenith to S0.89 horizon, a flat
  // 0.03 across the sky, which is what removed the pale horizon band the whole
  // palette hangs off and left every daylight frame reading as pool water.
  const satAmt = mix(u.skySaturation, u.skySatHorizon, horizonW)
  const resat = normaliseLuminance(boostSaturation(hued, satAmt))
  return vec3(resat.mul(level))
}

/** Rescale a colour to luminance 1. Chromaticity in, chromaticity out. */
export function normaliseLuminance(c: Node<'vec3'>): Node<'vec3'> {
  return vec3(c.div(luminance(c).max(1e-5)))
}

/** The sun disc plus its forward-scattering glow. Dome only, never the LUT. */
export function sunDisc(u: SkyNodes, dir: Node<'vec3'>): Node<'vec3'> {
  const mu = dot(dir, u.sunDir)
  const disc = smoothstep(0.99955, 0.99982, mu)
  // Two tight halos. A broad one reads as a blown-out white hole, which is
  // what the first pass of this milestone did.
  const halo = pow(saturate(mu), 90).mul(0.042).add(pow(saturate(mu), 14).mul(0.0016))
  return vec3(u.sunTransmittance.mul(u.sunDiscIntensity).mul(disc.add(halo)))
}
