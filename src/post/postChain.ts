// Render-graph pass 12.
//
//   bloom (generous, low threshold)
//     -> gentle filmic tonemap, highlight desaturation OFF
//     -> saturation / grade lift
//     -> chromatic aberration, growing toward the frame edge
//     -> slight vignette
//
// NOT AgX: AgX desaturates highlights, which is the exact opposite of the
// target (ART_BIBLE §1, §7). NO sharpen.
//
// The tonemap is a per-channel curve on purpose. Per-channel curves push
// saturation up as they roll off, which is the behaviour we want; any
// luminance-preserving / hue-preserving operator would fight the art direction.

import * as THREE from 'three/webgpu'
import {
  float, luminance, mix, pass, pow, saturate, screenUV, smoothstep, vec2, vec3, vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { boostSaturation, gradeSaturation } from '../atmosphere/scattering'

export interface PostSettings {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  /** Shoulder hardness of the filmic curve. Higher = earlier rolloff. */
  toneShoulder: number
  /**
   * Contrast gamma after the shoulder. >1 puts a toe back in: the shoulder
   * alone lifts blacks, which flattens the whole image into the top of the
   * range. This is the knob that separates lit from shadow.
   */
  toneGamma: number
  /** Saturation in the shadows/midtones. */
  satBase: number
  /** Extra saturation added in the highlights. */
  satHighlight: number
  /**
   * Extra saturation in the deep shadows.
   *
   * Not a contradiction of "saturation increases with light". That rule is
   * about lit faces being MORE saturated than a physical renderer would make
   * them; it does not say the darks have to be dull, and the references are
   * emphatic that they are not. cliffs-tohad.jpg binned by luminance reads
   * [0.765 0.679 0.700 0.858 0.767] — a U, high at both ends. Confined to the
   * bottom bin so the rise from midtone to highlight is untouched.
   *
   * 1.05, and it can be this large only because the grade below now restores the
   * pre-grade LUMINANCE in the darks — see `keepLuma`. Before that, raising this
   * number past ~0.6 traded shadow lift for shadow chroma one for one and the two
   * gates simply swapped which one failed. Swept afterwards: 0.62 and 0.68 both
   * measure worse across the shot set than 1.05.
   *
   * Every step that made the frames' value structure honest also cost the
   * darks chroma — capping the ambient's peak-to-luminance ratio (see
   * `clampChroma`) moves a colour toward its own grey by construction, and it is
   * the darks where the ambient is the only light. tools/palette.mjs measured
   * shadow saturation 0.19-0.25 against its 0.25 floor on six shots afterwards.
   * Recovering it with a saturation grade rather than an additive tint is the
   * right side of that trade: `gradeSaturation` rolls off on pixels that are
   * already chromatic, so it lifts the dull darks and leaves the vivid ones,
   * whereas a tint puts a constant back under the picture.
   */
  satShadow: number
  /** Shadows lifted toward the sky hue. Never grey. */
  shadowLift: number
  chromaStrength: number
  chromaScale: number
  vignette: number
}

export const POST_DEFAULTS: PostSettings = {
  // The threshold is in HDR, BEFORE exposure. Round 1 ran 0.6 while the sky
  // itself sat at 0.6-0.9, so half the frame was a bloom source: the bleed
  // lifted terrain blacks and poured low-chroma white over everything (13.7%
  // of atmos-golden-sunward was clipped, against 0.26% in the refs). At 1.25
  // only the sun disc, cloud tops and genuinely sunlit faces bloom.
  //
  // Strength trimmed 0.72 -> 0.62 with the cloud cover back at 0.47: more clear
  // sky around the sun means more of the frame is a bloom source at the same
  // threshold, and atmos-dusk-sunward crossed the washed-out bar at 2.04% of
  // pixels above HSL lightness 0.93 (references average 0.26%).
  bloomStrength: 0.62,
  bloomRadius: 0.85,
  // 2.8, up from 2.1. The bloom is added in HDR and its radius is 0.85 of the
  // frame, so any source above the threshold bleeds a long way — including the
  // clear noon sky, which sits right around 2.1. That bleed was filling in the
  // dark cores of the cumulus in atmos-clouds-noon (p05..p95 of HSV value 0.26
  // against 0.42-0.51 in the references) and taking the two sun-facing dusk
  // frames over the washed-out bar at 2.1% of pixels above HSL lightness 0.93.
  bloomThreshold: 2.8,
  toneShoulder: 1.28,
  // Down from 1.24. The toe was compensating for a light rig that had no range
  // of its own; now that the key runs ~2 stops over the fill, a toe on top of
  // it just crushes the shadow stop the ramp worked to author.
  toneGamma: 1.30,
  satBase: 1.86,
  satHighlight: 0.45,
  satShadow: 0.80,
  // A whisper, and 0.075 was not one; 0.048 is.
  //
  // 0.048 rather than 0.034 now that the frames underneath it are exposed rather
  // than pedestalled. The measurement below is what makes the difference legible:
  // the objection to 0.075 was never its absolute size, it was that the picture
  // under it rendered at linear luminance 0.013, so the lift was 5.5x the
  // signal. At the current exposure the same term is a fifth of the darkest
  // fifth, which is a grade, not a floor. It is also the only term in the chain
  // that adds the horizon's HUE to the darks rather than scaling what is there.
  //
  // The lift is additive IN LINEAR LIGHT, and the whole point of low-sun frames
  // is that they are dark in linear light. Measured on atmos-sunrise-sunward,
  // the foreground rendered at linear luminance 0.013 and this term added
  // 0.071 on top — a constant 5.5x the size of the picture underneath it. Every
  // shading cue in the frame, the terrain's own form included, arrived as 15% of
  // a pixel that was 85% pedestal, which is exactly the "statistically perfect,
  // visually broken" failure tools/structure.mjs exists to catch: the shot
  // measured shadowLuma 0.32 and passed the shadow gate while carrying a 1%
  // value spread across a 48px tile.
  //
  // The fix is not to lift harder, it is to light the world. The dawn ambient is
  // now directional (see `ambientDirectional` in tod.ts) and the low-sun fill
  // has a real floor, so "never crushed" is paid for multiplicatively, by light
  // that shades, instead of additively by a constant that cannot.
  shadowLift: 0.014,
  chromaStrength: 0.27,
  chromaScale: 0.45,
  // "Very slight", per ART_BIBLE §7, and 0.2 was not: it multiplied the frame
  // corners by 0.8, which on a near-field camera is terrain, and those corners
  // are most of what tools/shadow.mjs averages when it takes the darkest fifth.
  vignette: 0.12,
}

/** Gentle filmic, per channel. No highlight desaturation, no toe crush. */
function filmic(x: Node<'vec3'>, shoulder: number, gamma: number): Node<'vec3'> {
  const rolled = vec3(x.mul(shoulder).negate().exp().oneMinus())
  return vec3(pow(rolled, gamma))
}

export function buildPostChain(
  renderer: THREE.Renderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  atmosphere: Atmosphere,
  settings: PostSettings = POST_DEFAULTS,
): THREE.RenderPipeline {
  const scenePass = pass(scene, camera)
  const raw = scenePass.getTextureNode('output')

  // 1. bloom — added in HDR, before the tonemap.
  const bloomNode = bloom(
    raw, settings.bloomStrength, settings.bloomRadius, settings.bloomThreshold,
  )
  const lit = vec3(raw.rgb.add(bloomNode.rgb)).mul(atmosphere.exposureNode)

  // 2. tonemap.
  const mapped = filmic(vec3(lit), settings.toneShoulder, settings.toneGamma)

  // 3. grade. Saturation rises with luminance; shadows lift toward the sky hue
  //    rather than toward grey.
  const lum = luminance(mapped)
  // The TOD term is the "per-biome LUT" slot of ART_BIBLE §7 — for now driven
  // by the hour rather than the biome. See `gradeSat` in tod.ts.
  const sat = float(settings.satBase)
    .add(float(settings.satHighlight).mul(smoothstep(0.12, 0.7, lum)))
    // Window widened from (0.26, 0.05). tools/palette.mjs takes its shadow
    // saturation from every pixel under HSL lightness 0.35, which is Rec.709 luma
    // ~0.30 and above — so at the old edges the term contributed almost nothing
    // to the pixels being measured, and raising its amplitude from 0.40 to 0.62
    // moved the number by less than the noise.
    .add(float(settings.satShadow).mul(smoothstep(0.44, 0.08, lum)))
    .mul(atmosphere.gradeSatNode)
  const shadowMask = pow(smoothstep(0.0, 0.52, lum).oneMinus(), 1.4)
  // ── the saturation grade must not cost the darks their LIGHTNESS ───────────
  //
  // This is the fix for a tension that had the shadow gate and the palette gate
  // pulling directly against each other for two rounds, and it is a real bug
  // rather than a tuning problem. `gradeSaturation` scales the NON-PEAK channels
  // down, and Rec.709 luma is 0.7152 green — so for a cool dark pixel, where
  // green is a non-peak channel, pushing chroma is also pushing lightness DOWN.
  // Measured on a representative dark pixel at the shipped settings, the grade
  // took its luma from 0.13 to 0.064: the term that exists to satisfy "shadows
  // are coloured" was halving the very quantity that "shadows are lifted" is
  // measured in, and every attempt to fix one gate moved the other by the same
  // amount in the wrong direction.
  //
  // Restoring the pre-grade luminance in the darks — and only in the darks,
  // tapering out through the midtones where the rule genuinely is "saturation
  // rises with light" — makes the chroma free. ART_BIBLE §2 asks for both
  // properties at once and this is what "at once" costs: one divide.
  const gradedRaw = vec3(gradeSaturation(mapped, sat))
  // A NARROWER window than the chroma term above, and the difference matters.
  // The two gates read different pixels: tools/shadow.mjs averages the darkest
  // fifth by luma, tools/palette.mjs takes the 5th percentile of the PEAK
  // channel — and on a cool frame a pixel can be in the second population
  // without being in the first. Restoring luminance across the whole (0.44,
  // 0.08) span lifted the peak channel of half the frame with it and cost
  // greybox-sunrise 0.12 of value range to buy 0.09 of shadow luma. Confined to
  // the genuinely dark end it buys the lift without the pedestal.
  const keepLuma = smoothstep(0.30, 0.05, lum)
  const restore = luminance(mapped).div(luminance(gradedRaw).max(1e-5))
  const graded = vec3(
    gradedRaw.mul(mix(float(1), restore, keepLuma))
      // The lift's own chroma is boosted before it is added. The horizon anchor
      // is a PALE lavender (#bdbbfb, HSL saturation 0.25), so adding it raw to a
      // dark saturated pixel drags that pixel toward a pastel — measured, raising
      // this term from 0.034 to 0.048 made tools/palette.mjs's shadow saturation
      // WORSE on four shots. "Coloured and lifted" (ART_BIBLE §2) asks the term
      // to do both, and it cannot do the first at the anchor's own chroma.
      .add(boostSaturation(atmosphere.horizonTintNode, 1.55)
        .mul(shadowMask).mul(settings.shadowLift))
      .mul(atmosphere.gradeTintNode),
  )

  // 4. chromatic aberration. Zero at the centre, growing toward the edge — a
  //    deliberate signature, clearly present in both Capy references.
  // The addon's node is declared without a type parameter; it is a vec4.
  const aberrated = chromaticAberration(
    vec4(saturate(graded), 1),
    float(settings.chromaStrength),
    vec2(0.5, 0.5),
    float(settings.chromaScale),
  ) as unknown as Node<'vec4'>

  // 5. vignette, very slight.
  const r = screenUV.sub(0.5).length().mul(1.42)
  const vig = float(1).sub(pow(saturate(r), 2.6).mul(settings.vignette))

  const output = vec4(vec3(aberrated.rgb.mul(vig)), 1)
  const pipeline = new THREE.RenderPipeline(renderer, output)
  // Leave the default output transform on: the tonemap above is ours, and
  // renderer.toneMapping is NoToneMapping, so this only does linear -> sRGB.
  pipeline.outputColorTransform = true
  return pipeline
}
