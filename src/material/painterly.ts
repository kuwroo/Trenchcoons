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
  cameraPosition, dot, float, luminance, mix, mx_noise_float, normalWorld, positionLocal,
  positionWorld, pow, saturate, smoothstep, uniform, vec2, vec3,
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
  rimStrength: 0.5,
  rimPower: 3,
  saturationGain: 0.2,
  shadowSkyTint: 0.18,
  ambient: 1,
}

/**
 * Distances at which each brush octave has faded out, metres.
 *
 * Round 1 had a single fine octave dying at 240m, and every shot was taken from
 * a 180m-high vista where the nearest ground is ~260m out — so the fine octave
 * was mathematically zero in all eight PNGs and measured local contrast came in
 * 4-10x under the references. Three octaves on a distance ladder means SOME
 * octave is always carrying stroke character, at gameplay height and at a
 * vista, without the fine one aliasing into radial streaks at grazing angles.
 */
const BRUSH_FADE = { fine: 340, mid: 1500 } as const

const _c = new THREE.Color()
function hexToLinear(hex: number, out: THREE.Vector3): THREE.Vector3 {
  _c.setHex(hex, THREE.SRGBColorSpace)
  return out.set(_c.r, _c.g, _c.b)
}

/**
 * Anisotropic value noise: two octaves, one heavily stretched, which reads as
 * flat-brush strokes rather than as texture noise.
 */
function brushStroke(p: Node<'vec2'>): Node<'float'> {
  const coarse = mx_noise_float(vec3(p.x, p.y.mul(0.26), 0.0))
  const fine = mx_noise_float(vec3(p.x.mul(2.7).add(11.3), p.y.mul(0.72), 3.1))
  return coarse.mul(0.66).add(fine.mul(0.34))
}

/**
 * One-tap variant, for the octaves whose own frequency is already low.
 *
 * The stretched sub-octave above exists to give a stroke its internal grain; on
 * the mid and coarse octaves that grain lands below a pixel anyway, so paying
 * for it doubles the noise cost of the material for nothing. Three octaves at
 * two taps each is 18 noise evaluations per fragment and cost ~2ms at 1080p.
 */
function brushStrokeCheap(p: Node<'vec2'>): Node<'float'> {
  return mx_noise_float(vec3(p.x, p.y.mul(0.26), 0.0))
}

/**
 * Triplanar projection of the stroke pattern. Seamless on any topology.
 *
 * Faded out with distance: procedural noise has no mip chain, so at grazing
 * angles it aliases into radial streaks. Brush character is a near-field cue in
 * the references anyway — distance is carried by haze, not by texture.
 */
function triplanarBrush(scale: Node<'float'>): Node<'float'> {
  const p = vec3(positionWorld.div(scale))
  const a = vec3(normalWorld.abs())
  const w = vec3(pow(a.x, 4), pow(a.y, 4), pow(a.z, 4))
  const wsum = w.x.add(w.y).add(w.z).add(1e-4)
  const wx = w.x.div(wsum)
  const wy = w.y.div(wsum)
  const wz = w.z.div(wsum)
  const octave = (
    q: Node<'vec3'>, stroke: (v: Node<'vec2'>) => Node<'float'>,
  ): Node<'float'> =>
    stroke(vec2(q.z, q.y)).mul(wx)
      .add(stroke(vec2(q.x, q.z)).mul(wy))
      .add(stroke(vec2(q.x, q.y)).mul(wz))

  const dist = positionWorld.sub(cameraPosition).length()
  const fine = octave(p, brushStroke)
    .mul(smoothstep(BRUSH_FADE.fine, BRUSH_FADE.fine * 0.25, dist))
  const mid = octave(vec3(p.div(3.2)), brushStrokeCheap)
    .mul(smoothstep(BRUSH_FADE.mid, BRUSH_FADE.mid * 0.15, dist))
  // Never faded: low-frequency enough that it cannot alias, and it is what
  // carries the big patches of value the references break their masses into.
  // Kept to a 6x step rather than 13x — at 13x the patch period on the meadow
  // was ~100m, which reads as a stain rather than a brush mark from a
  // gameplay-height camera.
  const coarse = octave(vec3(p.div(6)), brushStrokeCheap)
  return fine.mul(0.36).add(mid.mul(0.40).add(coarse.mul(0.30)))
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
    rimStrength: uniform(0.5),
    rimPower: uniform(3),
    saturationGain: uniform(0.4),
    shadowSkyTint: uniform(0.5),
    ambient: uniform(1),
  }

  constructor(atmosphere: Atmosphere, params: Partial<PainterlyParams> = {}) {
    this.params = { ...PAINTERLY_DEFAULTS, ...params }
    const u = this.u
    const n = vec3(normalWorld)

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
    const scaleHigh = mix(float(1), scaleLow, 0.45)
    const softLow = u.rampSoftness.mul(scaleLow)
    const softHigh = u.rampSoftness.mul(scaleHigh)
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
    const ambient = vec3(atmosphere.skyIrradiance(n)
      .mul(atmosphere.ambientGainNode).mul(u.ambient))
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
    const stroke = triplanarBrush(u.brushScale).mul(u.brushStrength)
    // Value down-modulation only on the negative side is deliberate: strokes
    // that only ever brighten push the whole surface toward white, which is how
    // round 1 ended up with a single highlighter-lime wash.
    albedo = vec3(setSaturation(
      vec3(albedo.mul(stroke.mul(0.72).add(1))),
      stroke.mul(u.brushSaturation).mul(0.75).add(1),
    ))

    // ── light: sky ambient (coloured, lifted) + ramped direct ─────────────────
    const level = mix(float(0), u.midLevel, toMid)
    const direct = vec3(atmosphere.sunColorNode.mul(mix(level, float(1), toLit)))
    let color: Node<'vec3'> = vec3(albedo.mul(ambient.add(direct)))

    // ── soft sky-coloured rim ────────────────────────────────────────────────
    const view = vec3(cameraPosition.sub(positionWorld).normalize())
    const rim = pow(saturate(dot(n, view).oneMinus()), u.rimPower).mul(u.rimStrength)
    color = vec3(color.add(ambient.mul(rim).mul(0.85)))

    // ── saturation rises with luminance (ART_BIBLE §2) ────────────────────────
    const lum = luminance(color)
    color = gradeSaturation(color, u.saturationGain.mul(smoothstep(0.03, 0.7, lum)).add(1))

    // ── aerial perspective, in-shader ────────────────────────────────────────
    this.material.colorNode = atmosphere.aerialPerspective(color, vec3(positionWorld))
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
    u.rimStrength.value = p.rimStrength
    u.rimPower.value = p.rimPower
    u.saturationGain.value = p.saturationGain
    u.shadowSkyTint.value = p.shadowSkyTint
    u.ambient.value = p.ambient
  }
}
