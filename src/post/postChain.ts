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
import { float, luminance, pass, pow, saturate, screenUV, smoothstep, vec2, vec3, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { gradeSaturation } from '../atmosphere/scattering'

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
   * Raised to 0.40 once the low-sun frames were properly exposed rather than
   * pedestalled by `shadowLift`: with the additive lift cut from 0.075 to 0.034
   * the darks lost the sky hue that lift was injecting, and tools/palette.mjs
   * measured shadow saturation down at 0.14-0.24 against the 0.25 floor.
   * Recovering it with a saturation grade rather than an additive tint keeps the
   * darks chromatic without putting a constant back under the picture.
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
  bloomStrength: 0.72,
  bloomRadius: 0.85,
  bloomThreshold: 2.1,
  toneShoulder: 1.28,
  // Down from 1.24. The toe was compensating for a light rig that had no range
  // of its own; now that the key runs ~2 stops over the fill, a toe on top of
  // it just crushes the shadow stop the ramp worked to author.
  toneGamma: 1.44,
  satBase: 1.78,
  satHighlight: 0.45,
  satShadow: 0.40,
  // A whisper, and 0.075 was not one; 0.034 is.
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
  shadowLift: 0.034,
  chromaStrength: 0.27,
  chromaScale: 0.45,
  vignette: 0.2,
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
    .add(float(settings.satShadow).mul(smoothstep(0.26, 0.05, lum)))
    .mul(atmosphere.gradeSatNode)
  const shadowMask = pow(smoothstep(0.0, 0.52, lum).oneMinus(), 1.4)
  const graded = vec3(
    gradeSaturation(mapped, sat)
      .add(atmosphere.horizonTintNode.mul(shadowMask).mul(settings.shadowLift))
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
