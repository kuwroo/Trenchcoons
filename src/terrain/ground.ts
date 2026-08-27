// The terrain material.
//
// A SECOND material, not a variant of `material/painterly.ts`, and the split is
// deliberate. The painterly material is authored per-asset from one surface def
// and carries the triplanar brush ladder; terrain needs neither. What it needs
// instead is a palette that VARIES ACROSS THE SURFACE — six biomes blended
// continuously — and CLAUDE.md now forbids the one thing painterly.ts exists to
// do on ground: "No brush-stroke overlay on terrain. Surfaces are clean."
//
// So this is the clean Genshin register: three authored stops selected by a
// 3-stop ramp, the stops themselves sampled from the baked biome maps, a second
// colour on slopes for exposed rock, and nothing else on the surface but the
// light. Everything that carries fidelity here is either the light (ART_BIBLE
// §1.1) or the silhouette of what is scattered on top of it (§1.2-3).
//
// It reads exactly the same atmosphere uniforms painterly.ts does, so terrain
// and props stay in the same light.

import * as THREE from 'three/webgpu'
import {
  cameraPosition, dot, float, luminance, mix, modelWorldMatrix, mx_noise_float, normalize,
  normalWorld, positionLocal, positionWorld, pow, saturate, smoothstep, texture, uniform,
  vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { DeformHook } from '../material/painterly'
import {
  boostSaturation, clampChroma, gradeSaturation, setSaturation,
} from '../atmosphere/scattering'
import type { TerrainWorld } from './world'

/** sRGB byte -> linear. The maps store authored sRGB; this undoes it. */
const decode = (c: Node<'vec3'>): Node<'vec3'> => vec3(pow(c, float(2.2)))

export interface GroundOptions {
  /**
   * Whether this instance pays for VERTEX displacement from the deformation
   * field. Compile-time, not a multiply by zero: a surface that takes no relief
   * gets no `positionNode` at all and therefore none of the vertex-stage
   * texture fetches behind it.
   *
   * True only on the clipmap's two finest levels — 0.55 m and 1.1 m cells,
   * which are the only ones where a 10-35 cm rut is more than a fraction of a
   * quad. Levels 2 and up would be paying ten fetches per vertex to move a
   * 140 m triangle by nothing.
   */
  relief: boolean
}

export class GroundMaterial {
  readonly material = new THREE.MeshBasicNodeMaterial()

  /** Extra scale on the sky ambient, on top of the atmosphere's own. A debug
   *  lever for A/B-ing the fill; the per-biome ambient arrives through
   *  `Atmosphere.setBiomeGrade`, not through this. */
  readonly ambientScaleNode = uniform(1)

  constructor(
    atmosphere: Atmosphere,
    world: TerrainWorld,
    deform: DeformHook | null,
    options: GroundOptions = { relief: false },
  ) {
    const span = float(world.span)
    const wp = vec3(positionWorld)
    const mapUv = vec2(wp.x, wp.z).div(span).add(0.5)

    const rawBase = decode(vec3(texture(world.baseMap, mapUv).rgb))
    const rawShade = decode(vec3(texture(world.shadowMap, mapUv).rgb))
    const litTap = texture(world.litMap, mapUv)
    const rawLit = decode(vec3(litTap.rgb))
    const cliffTap = texture(world.cliffMap, mapUv)
    const cliff = decode(vec3(cliffTap.rgb)).toVar()

    // ── the shading normal ───────────────────────────────────────────────────
    let n: Node<'vec3'> = vec3(normalize(normalWorld))
    let dfm: ReturnType<DeformHook['shade']> | null = null
    if (deform) {
      dfm = deform.shade(wp)
      // The term that makes a rut read as a rut on ground that has nowhere near
      // the vertices to bend into one. ART_BIBLE §2: "detail lives in the
      // light, not the geometry."
      // Clamped: one texel of a 35 cm snow rut is a 70-degree slope, and an
      // unclamped tilt turns the mark's own edge into a black rim.
      const g = vec2(
        dfm.slope.x.clamp(-1.6, 1.6), dfm.slope.y.clamp(-1.6, 1.6),
      ).mul(1.4)
      n = vec3(normalize(n.add(vec3(g.x.negate(), 0, g.y.negate()))))
    }
    n = vec3(n).toVar()

    // ── flat sculptural planes: the slope material ───────────────────────────
    //
    // The single biggest thing separating refs/genshin/grasslands.jpg from a
    // green heightfield is that its slopes are a DIFFERENT MATERIAL from its
    // flats — bare stepped rock where the grass cannot hold. That is one
    // smoothstep on the normal, and because the rock colour comes out of the
    // biome map it is dark basalt in the alpine, warm ochre in the desert and
    // damp brown in the meadow without a second code path.
    //
    // Sharpened deliberately: a wide blend produces the airbrushed
    // grass-fading-into-rock look this art direction was abandoned for. The
    // transition is ~15 degrees of slope wide.
    //
    // THE THRESHOLD IS NOW PER BIOME, out of the litMap's alpha channel, and it
    // was one global constant. Two things were wrong with the constant at once:
    //
    //   It was 0.72..0.52 — 44 to 59 degrees — and a MEADOW whose own relief is
    //   6 m over 120 m never gets there, so the grey-blue rock plane that is the
    //   defining form of refs/genshin/grasslands.jpg occupied 0.00% of the frame
    //   against the reference's 3.01%. This file's docstring blamed a wide
    //   threshold for "broad brown blotches on green" and was reading its own
    //   symptom: the meadow's `cliff` colour was damp brown DIRT, so a wide
    //   reveal WAS mud. Against blue-grey rock the same reveal is the thing the
    //   reference is made of. The colour and the threshold had to move together
    //   and only one of them did.
    //
    //   And the same 44 degrees was applied to the ALPINE, where ART_BIBLE §4
    //   says the dark rock ridges are "doing all the compositional work" and are
    //   "the only place high contrast is allowed". Snow does not lie on a
    //   wind-scoured ridge; that biome needs its rock from about 18 degrees, and
    //   at 44 it had none at all (55.9% dead-flat foreground tiles, a
    //   featureless white slope).
    //
    // So `rockSlope` joins ground colour, scatter set, grass density and light as
    // a per-biome field — which is the whole "a hue shift is not a biome" rule,
    // applied to the one column that was still global. The window is kept narrow
    // (+0.05 / -0.13 around the centre, roughly 15 degrees of slope) because a
    // wide blend is the airbrushed grass-fading-into-rock look this art direction
    // was abandoned for.
    const rockMid = litTap.a.toVar()
    const rock = smoothstep(rockMid.add(0.05), rockMid.sub(0.13), n.y).toVar()
    const base = vec3(mix(rawBase, cliff, rock)).toVar()
    const shade = vec3(mix(rawShade, cliff.mul(0.55), rock)).toVar()
    const lit = vec3(mix(rawLit, cliff.mul(1.45), rock)).toVar()

    // ── ground modelling: LOW frequency, LOW amplitude, value only ───────────
    //
    // Not the brush overlay. Two octaves at 34 m and 9 m moving VALUE by a few
    // percent, which is what stops a hillside being a single flat wash without
    // reintroducing the mottled camouflage. No hue axis, no saturation axis, no
    // screen-space LOD ladder — those were the painterly path and they are
    // withdrawn. Turning `TINT` to 0 should look almost identical from 50 m and
    // very slightly flatter at 3 m; if it looks like a different art direction,
    // this term is too strong.
    const TINT = 0.075
    const tone = mx_noise_float(vec3(wp.x.mul(1 / 34), wp.y.mul(1 / 90), wp.z.mul(1 / 34)))
      .mul(0.7)
      .add(mx_noise_float(vec3(wp.x.mul(1 / 9), wp.y.mul(1 / 24), wp.z.mul(1 / 9))).mul(0.3))

    // ── near-field ground texture ────────────────────────────────────────────
    //
    // NOT the brush overlay, and the distinction is the whole reason this is
    // three lines rather than the two hundred in painterly.ts. The brush was a
    // triplanar stroke ladder selected by PROJECTED SIZE, so it was present at
    // 3 m and at 3 km, carried a hue axis, a saturation axis, a region mask and
    // a normal perturbation, and read as camouflage. This is one world-locked
    // pair of octaves at 0.9 m and 0.32 m moving VALUE only, faded out entirely
    // by 90 m.
    //
    // It is here because the alternative is a lie about the reference.
    // refs/genshin/grasslands.jpg is not a flat colour: at 48 px tiles it
    // measures 0.069 of local detail against 0.001-0.03 for a clean ramp on
    // smooth terrain, and that detail is grass, litter and ground texture at
    // roughly a metre. "Surfaces are clean" means no gouache mottle, not
    // "terrain is a solid fill".
    //
    // Faded by distance because procedural noise has no mip chain: a 32 cm
    // octave surviving to 500 m is a sub-pixel octave that aliases into radial
    // crawl the moment the camera moves. Everything past 90 m gets its detail
    // from silhouettes instead — scatter, grass and the terrain's own form.
    // 0.11. At 0.17 the driver's-eye capture came back OVER-DETAILED (tile
    // detail 0.096 against a reference band of 0.056-0.080) with 0.12% speckle
    // — the 32 cm octave landing at roughly a pixel and aliasing. The gate has
    // a ceiling as well as a floor for exactly this reason and it is right to.
    const FINE = 0.085
    const toCam = vec3(wp.sub(cameraPosition)).length()
    const nearFade = smoothstep(float(90), float(18), toCam)
    const fine = mx_noise_float(vec3(wp.x.mul(1 / 0.9), wp.y.mul(1 / 1.4), wp.z.mul(1 / 0.9)))
      .mul(0.62)
      .add(mx_noise_float(
        vec3(wp.x.mul(1 / 0.32).add(11.5), wp.y.mul(1 / 0.5), wp.z.mul(1 / 0.32)),
      ).mul(0.38))
    // A third octave for the FIRST FIVE METRES only. At a 1.6 m eye a 48 px
    // tile covers about 9 cm of ground, so the two octaves above are almost
    // constant across one and the close-range capture measured 42% of its
    // tiles dead flat while looking perfectly reasonable. Gone by 14 m, which
    // is well inside the distance at which an 11 cm feature would start to
    // alias.
    const microFade = smoothstep(float(14), float(3), toCam)
    const micro = mx_noise_float(
      vec3(wp.x.mul(1 / 0.11).sub(4.5), wp.y.mul(1 / 0.18), wp.z.mul(1 / 0.11)),
    )
    // GRAIN. How much near-field texture this ground is allowed to carry, from
    // the biome map's alpha channel — which is grass density, and grass density
    // is the right proxy: the thing being modelled is litter, root mat and
    // blade shadow, and a dune has none of it.
    //
    // This is not a tidy-up. CLAUDE.md records the exact failure it prevents:
    // "the structure gate's detail floor pushed a builder to make the M4 sand
    // pan noisier to clear it, and the surface's own blotches then
    // out-contrasted the tyre marks the pan exists to display." Adding the fine
    // octaves uniformly did it again — `npm run distinct`'s corridor ratio fell
    // from 5.33 to 1.09 against a 1.25 floor, with bare sand's own local
    // contrast going from 1.03 to 10.21. Sand is smooth; grass is not; the map
    // already knows which is which.
    // THE FLOOR IS 0.55, up from 0.12, and the 0.12 was measured to be wrong in
    // the other direction. The reasoning behind it stands — a noisy sand pan
    // out-contrasts the tyre marks it exists to display, and `npm run distinct`
    // caught exactly that — but 0.12 does not suppress the surface's own
    // contrast, it deletes the surface. Measured on the sand shots at 0.12:
    // median tile detail 0.0018 with 84% of foreground tiles DEAD FLAT, against
    // 0.0799 for refs/painterly/desert-hazy.jpeg, which is sand and is not flat.
    // A dune has litter, ripple and grain; what it does not have is a root mat.
    // The corridor ratio the old floor was protecting has 2.3x of headroom over
    // its 1.25 requirement, which is what pays for this.
    const grain = cliffTap.a.mul(1.1).add(0.55).clamp(0.55, 1.15)
    const toneGain = tone.mul(TINT)
      .add(fine.mul(FINE).mul(nearFade).mul(grain))
      .add(micro.mul(0.062).mul(microFade).mul(grain))
      .add(1).toVar()

    // ── 3-stop ramp, identical in shape to the props' ────────────────────────
    // Same scaling against sun height as painterly.ts, for the same reason: a
    // threshold compared against a raw N.L cannot mean the same thing at a
    // 58 degree sun and a 7 degree one.
    const ndotl = dot(n, atmosphere.nodes.sunDir)
    const vis = atmosphere.sunVisibility(wp)
    const scaleLow = atmosphere.rampScaleNode
    const scaleShadow = scaleLow.mul(atmosphere.rampShadowGainNode)
    const scaleHigh = mix(float(1), scaleLow, 0.22)
    // 0.30, twice painterly.ts's authored width.
    //
    // The terrain's own 88 m and 46 m octaves swing N.L across the shadow step
    // over tens of metres, and at a cel-hard width every one of those swings
    // became a dark blob in the middle of a sunlit hillside. Measured with the
    // cast shadows disabled entirely, the frame did not change — so the blobs
    // were the ramp, not the shadow map. A wider terminator on TERRAIN and a
    // narrow one on PROPS is also what the reference does: the grassland in
    // refs/genshin/grasslands.jpg is softly modelled and the rocks sitting on it
    // are hard-edged.
    const soft = float(0.30)
    const softLow = soft.mul(mix(float(1), scaleLow, 0.55))
    const softHigh = soft.mul(mix(float(1), scaleHigh, 0.55))
    // 0.22, not painterly.ts's 0.30. That threshold was authored for a surface
    // carrying a brush field whose region term shifts the ramp input around it;
    // on a clean surface the same number puts every face more than ~13 degrees
    // off the sun onto the shadow stop, which on rolling terrain is half the
    // frame. The reference's grassland is almost entirely mid-to-lit with the
    // shadow stop kept for faces genuinely turned away.
    const shadowT = float(0.22).mul(scaleShadow).toVar()
    const litT = float(0.88).mul(scaleHigh).toVar()
    const toMid = smoothstep(shadowT.sub(softLow), shadowT.add(softLow), ndotl).mul(vis).toVar()
    const toLit = smoothstep(litT.sub(softHigh), litT.add(softHigh), ndotl).mul(vis).toVar()

    // ── ambient from the sky LUT (never a constant — CLAUDE.md) ──────────────
    const ambient = vec3(
      atmosphere.skyIrradiance(n).mul(atmosphere.ambientGainNode).mul(this.ambientScaleNode),
    ).toVar()
    const skyHue = vec3(ambient.div(luminance(ambient).max(1e-4))).toVar()
    // Shadows coloured and lifted, tinted toward the sky. Chroma-capped, or the
    // dawn sky's near-pure blue turns every shaded slope navy — see
    // `clampChroma` and the long note on `shadowSkyTint` in painterly.ts.
    const skyShadow = clampChroma(
      boostSaturation(vec3(skyHue.mul(luminance(shade))), 1.2),
      atmosphere.ambientChromaNode,
    )
    // 0.10, half of painterly.ts's authored 0.18-0.20.
    //
    // ART_BIBLE §2: "the references cool their shade, they do not recolour it —
    // grasslands' grass shadow is rgb(83,154,88), still unmistakably GREEN at
    // hue 124." At 0.20 x the low-sun boost this mix reaches 0.64 and the
    // shaded half of every hill came back violet, which is precisely the
    // failure the docstring on `shadowSkyTint` warns about and which the
    // painterly surface hid behind its own brush and hue rotation.
    const shadowStop = vec3(mix(
      shade, skyShadow, saturate(float(0.10).mul(atmosphere.shadowTintBoostNode)),
    ))

    let albedo: Node<'vec3'> = vec3(mix(shadowStop, base, toMid))
    albedo = vec3(mix(albedo, lit, toLit))
    albedo = vec3(albedo.mul(toneGain))

    // ── the tyre mark ────────────────────────────────────────────────────────
    // Same treatment the painterly ground had, and the reason it now shows up
    // everywhere is upstream of this file: `darken`, `chroma` and `expose`
    // arrive from the field's per-biome response map rather than from one
    // rectangular patch, so ordinary grass, dirt, sand and snow all have an
    // authored answer instead of sharing the world default.
    if (dfm) {
      const dm = saturate(dfm.mask).toVar()
      const dark = dfm.darken.mul(mix(float(0.42), float(1), dfm.wet))
      let disturbed: Node<'vec3'> = vec3(albedo.mul(dark.oneMinus().max(0.05)))
      // "Deep ruts expose dirt and rock" — and on terrain the thing underneath
      // is the biome's own slope material, which is already sampled.
      disturbed = vec3(mix(
        disturbed, vec3(cliff.mul(0.6)),
        saturate(dfm.expose.mul(dfm.depth.mul(2.4))),
      ))
      disturbed = vec3(gradeSaturation(disturbed, dfm.chroma))
      albedo = vec3(mix(albedo, disturbed, dm))
    }

    // ── light ────────────────────────────────────────────────────────────────
    // `midLevel` 0.42. The mid stop takes 42% of the direct term, which is what
    // keeps a shaded-but-not-occluded slope inside the value range instead of
    // collapsing onto the ambient.
    // A FILL FLOOR of 0.12, and it is the literal implementation of ART_BIBLE
    // §2's "shadows are coloured and LIFTED ... never crushed". Without it a
    // fragment on the shadow stop receives sky ambient and nothing else, so a
    // green albedo times a blue noon sky lands at Rec.709 luma ~0.12 against
    // the reference's shaded grass at 0.30-0.40. It is bounce light, which is
    // the one direct-lighting term a diffuse-only NPR model has no other way to
    // express.
    // 0.16, raised from 0.12, and the alpine is what set it. ART_BIBLE §4 authors
    // snow shadow at #A8C4DC and says the biome is "HIGH KEY, LOW CONTRAST ...
    // the whole biome sits in the top third of the value range. Resist adding
    // contrast to 'make it read'." An authored stop at luma 0.72 was arriving on
    // screen at p05 0.179 — a navy wall — because a fragment inside a cast shadow
    // gets `ambient + 0.12 x sun` and nothing else. The shadow gate agrees
    // independently: five shots CRUSHED against a 0.299 floor, and shadow/lit
    // ratios of 0.205-0.359 against a 0.364 one.
    const FILL = float(0.16)
    const direct = vec3(
      atmosphere.sunColorNode.mul(mix(toMid.mul(0.36).add(FILL), float(1), toLit)),
    )
    let color: Node<'vec3'> = vec3(albedo.mul(ambient.add(direct)))

    // A small sky rim, weighted by the albedo itself so it cannot recolour the
    // shade. See the long note in painterly.ts: an unweighted rim is a constant
    // over the whole frame at the grazing angles a 3.5 m camera sees.
    const view = vec3(cameraPosition.sub(wp).normalize())
    const rim = pow(saturate(dot(n, view).oneMinus()), float(3)).mul(0.16)
    color = vec3(color.add(albedo.mul(ambient).mul(rim).mul(1.2)))

    // Wet marks are the one place ART_BIBLE allows specular on ground.
    if (dfm) {
      const half = vec3(normalize(atmosphere.nodes.sunDir.add(view)))
      const gloss = dfm.wet.mul(dfm.mask).mul(0.4)
      const spec = pow(saturate(dot(n, half)), float(46)).mul(gloss)
      color = vec3(color.add(atmosphere.sunColorNode.mul(spec).mul(vis).mul(0.9)))
    }

    // ── chroma FALLS with luminance (ART_BIBLE §2, measured) ────────────────
    //
    // `setSaturation`, not `gradeSaturation`, and that is a BUG FIX rather than a
    // preference. `gradeSaturation` ends in `pow(ratio, k.max(0).mul(weight))`,
    // and the `k.max(0)` means it is a strict no-op for any amount below 1 —
    // which is every amount this call site has ever passed it. So the one term in
    // the terrain material that implements §2's measured "a lit surface ... LOSES
    // ~0.15 saturation" compiled to `color = color`, in this file and in the
    // identical line in painterly.ts. Measured consequence, against the
    // reference at 1:1: ours lit S0.769 / shaded S0.512, dS +0.257, where
    // refs/genshin/grasslands.jpg reads lit S0.603 / shaded S0.560, dS -0.043.
    // The rule was authored, documented, gated for, and never ran.
    //
    // `setSaturation` mixes toward the grey of the SAME luminance, so it takes
    // chroma out without touching the value the shadow gate measures. Its own
    // docstring names it as the operator for the amount < 1 case.
    const lum = luminance(color)
    color = setSaturation(color, float(0.16).mul(smoothstep(0.03, 0.7, lum)).oneMinus())

    // Aerial perspective in-shader, with a ZERO stroke term — the haze may not
    // carry a brush pattern any more, because there is no brush.
    this.material.colorNode = atmosphere.aerialPerspective(color, wp, float(0))
    this.material.name = options.relief ? 'terrain-ground-relief' : 'terrain-ground'

    // ── vertex relief ────────────────────────────────────────────────────────
    if (deform && options.relief) {
      // Sampled at the UNDISPLACED world position: `positionWorld` is derived
      // FROM `positionNode`, so reading it to decide what `positionNode` should
      // be is circular. `positionNode` is local space.
      //
      // KNOWN GAP, stated rather than hidden: the shadow cascades render with
      // `scene.overrideMaterial`, which replaces `positionNode`, so a displaced
      // rut casts an undisplaced shadow. Bounded by the deepest rut the art
      // bible allows (0.35 m) against a cascade texel of several metres.
      const disp = deform.displace(
        vec3(modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz),
      )
      this.material.positionNode = vec3(positionLocal.add(vec3(0, disp, 0)))
    }
  }

  dispose(): void { this.material.dispose() }
}
