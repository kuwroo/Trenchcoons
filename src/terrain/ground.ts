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

    // ── the biome lookup is WARPED, not straight ──────────────────────────────
    //
    // ART_BIBLE §5's transitions are "ambiguity in the classifier", and the
    // classifier is right; what was wrong was the LOOKUP. The palette maps are
    // 16 m per texel and bilinearly filtered, so a blend band came out as a
    // smooth ramp from one biome's colour to the other's — and the average of
    // ART_BIBLE's dune (#EFD08F) and its grass is olive. Measured on
    // shots/biome-transition.png, the ground read hue 62-63: chartreuse, which is
    // a colour neither biome contains and which the harsh critic named
    // specifically.
    //
    // Nature does not average at a boundary, it interlocks — fingers of grass
    // running down into sand, patches of sand showing through thinning turf. Two
    // octaves of world-locked noise displacing the map lookup by up to ~26 m
    // produces exactly that, and it costs two noise taps and no extra fetches:
    // the sample is still the honest classification, taken a few metres away. In
    // the middle of a biome, where the maps are locally constant, it does
    // nothing at all — so this cannot change any frame except a transition.
    const warpN = mx_noise_float(vec3(wp.x.mul(1 / 76), wp.y.mul(1 / 240), wp.z.mul(1 / 76)))
      .mul(0.72)
      .add(mx_noise_float(
        vec3(wp.x.mul(1 / 27).add(51.5), wp.y.mul(1 / 90), wp.z.mul(1 / 27)),
      ).mul(0.28))
    const warpM = mx_noise_float(vec3(
      wp.z.mul(1 / 76).sub(19.5), wp.y.mul(1 / 240), wp.x.mul(1 / 76).add(7.5),
    ))
    // 150 m of authored amplitude against a measured noise sigma of 0.17 is about
    // 26 m of actual displacement. Deliberately larger than one texel: a warp
    // smaller than the map's own 16 m grid would only soften the bilinear ramp.
    const WARP = float(150)
    const mapUv = vec2(
      wp.x.add(warpN.mul(WARP)), wp.z.add(warpM.mul(WARP)),
    ).div(span).add(0.5)

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
    // 0.26. Same unit correction as `FINE` below: `mx_noise_float` has a measured
    // standard deviation of 0.17, so an authored 0.075 was moving value by about
    // 1.3% — "almost identical from 50 m", as the note says, and also almost
    // identical from 3 m. At 0.26 the pair is worth ~4% of value at 34 m and 9 m,
    // which is a LARGE-SCALE mass rather than texture: it cannot alias at any
    // distance and it survives the haze, because a 34 m feature is still 34 m at
    // 800 m.
    //
    // A THIRD octave at 260 m was tried and reverted, and it is worth recording
    // as a measured negative because the reasoning for it was sound. The vista
    // captures have no value structure — median tile detail 0.014-0.029 against
    // the structure gate's 0.031 floor, and no pixel below HSL lightness 0.35
    // against the 2.8-11.2% the references carry — and a 260 m octave is the
    // scale of a shaded valley flank, which is what breaks a landscape into
    // masses in refs/genshin/grasslands.jpg. It did not work: at equal total
    // amplitude it cost one shot on the structure gate and moved nothing else,
    // because the thing those frames are missing is not low-frequency VALUE, it
    // is CONTENT — dark vegetation and rock silhouettes at 600 m to 3 km. Value
    // noise cannot substitute for a tree.
    const TINT = 0.26
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
    // 0.34, and the jump from 0.085 is a UNIT correction, not a taste change.
    // `mx_noise_float`'s nominal range is [-1, 1] and its measured standard
    // deviation is 0.17 (see MARK_SIGMA in src/atmosphere/scattering.ts, which
    // measures exactly this), so an authored 0.085 was moving value by 1.4% and
    // the term that exists to keep sand from being a flat wash was contributing
    // half a percent of it. Measured: the sand captures came back at median tile
    // detail 0.0018-0.0025 against refs/painterly/desert-hazy.jpeg's 0.0799 —
    // the reference IS sand and is forty times more textured. At 0.26 the same
    // surface lands in the low end of the gate's 0.031-0.093 band; pushed further
    // it starts to trip the ANTI-GAMING metric instead (gradient concentration
    // fell to 3.2-8.2 against a reference floor of 11.9 at 0.34), which is the
    // gate correctly saying that uniform wobble is not the same thing as flat
    // masses meeting at hard edges. Noise can stop a surface being empty; it
    // cannot make it painted.
    const FINE = 0.26
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
    // GRAIN IS NOW INVERTED, and the inversion is the whole insight. It used to
    // rise with grass density on the argument that litter and root mat are what
    // the noise models; the trouble is that where there is grass there are also
    // ten thousand instanced TUFTS, and they supply that detail as geometry. The
    // two measurements that force the flip:
    //
    //   shots/ground-noon.png, dense meadow    tile detail 0.102  — OVER-DETAILED
    //   shots/tracks-fresh.png, bare coast     tile detail 0.002  — FORMLESS
    //
    // Same material, same term, both ends of the gate's 0.031-0.093 band and both
    // outside it, because the term was strongest exactly where the geometry had
    // already filled the budget and weakest where nothing else could. So: the
    // near-field detail budget is filled by grass where grass exists, and by the
    // surface where it does not.
    //
    // The original note this replaces is still right about the risk it names —
    // CLAUDE.md records a builder making the sand pan noisier to clear the
    // structure gate until "the surface's own blotches out-contrasted the tyre
    // marks the pan exists to display" — so the number is checked against
    // `npm run distinct`'s corridor ratio, not just against the structure gate.
    const grain = cliffTap.a.mul(1.9).oneMinus().clamp(0.28, 1.0)
    const toneGain = tone.mul(TINT)
      .add(fine.mul(FINE).mul(nearFade).mul(grain))
      .add(micro.mul(0.18).mul(microFade).mul(grain))
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
    // 0.34, up from 0.22, and this is the term that gives a LANDSCAPE its value
    // structure. The note above is right that "the reference's grassland is
    // almost entirely mid-to-lit", and it drew the wrong conclusion from it: the
    // reference is mid-to-lit because most of the ground in it FACES the sun, not
    // because its threshold is low. At 0.22 every face within about 77 degrees of
    // the sun took the mid stop, which on rolling terrain is essentially all of
    // it, and the measured result was a frame with no dark pixels at all — the
    // palette gate reported "0% of the frame below HSL L 0.35" on five vista
    // captures against the 2.8-11.2% the references carry, and the structure gate
    // called the same frames FORMLESS.
    //
    // Raising the threshold rather than darkening the stop is the right side of
    // that trade, and the two gates read differently enough for it to be free:
    // tools/shadow.mjs averages the darkest FIFTH, so putting more area into the
    // shadow stop moves the boundary of that fifth UP rather than pulling its
    // mean down, while tools/palette.mjs counts pixels under a lightness and
    // therefore gets more of them. Darkening the authored stop would have done
    // the opposite to the first gate.
    const shadowT = float(0.34).mul(scaleShadow).toVar()
    const litT = float(0.88).mul(scaleHigh).toVar()
    const toMid = smoothstep(shadowT.sub(softLow), shadowT.add(softLow), ndotl).mul(vis).toVar()
    const toLit = smoothstep(litT.sub(softHigh), litT.add(softHigh), ndotl).mul(vis).toVar()

    // ── ambient from the sky LUT (never a constant — CLAUDE.md) ──────────────
    // CHROMA-CAPPED at 1.6, and this is the term that was erasing the ground's
    // own hue in shade. Rec.709 weights blue at 0.0722, so a clear noon sky's
    // irradiance comes back with its peak channel about 2.7x its own luminance —
    // multiply any albedo by that and the product is the SKY's chromaticity, not
    // the material's. Measured: shaded ground rendered rgb(36,88,125) at H205
    // while the lit grass beside it sat at H88, a 117-degree gap where ART_BIBLE
    // §2 asks for about 40 ("shadows are tinted toward the sky hue ... never
    // grey" — tinted, not replaced) and where the reference measures 37.
    //
    // 1.6 is a cap, not a conversion: anything already inside it is untouched, so
    // dawn and dusk keep their warmth and the noon sky still cools the shade
    // clearly. It is the same operator, for the same reason, that `skyShadow`
    // below and painterly.ts's ambient chain already use — this call site was
    // simply the one that had been missed, and it is the one that multiplies the
    // albedo.
    const ambient = vec3(clampChroma(
      vec3(atmosphere.skyIrradiance(n)
        .mul(atmosphere.ambientGainNode).mul(this.ambientScaleNode)),
      float(1.6),
    )).toVar()
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
      // ── the mark stays INSIDE the biome's palette ─────────────────────────
      //
      // It used to be `albedo * (1 - dark)`, floored at 0.05 — a multiply toward
      // black. On sand that reads correctly, because sand's `darken` is small and
      // the reference (refs/mkw/beach-wet-sand-tracks.jpg) genuinely is "the same
      // sand, much darker". On GRASS, whose `darken` is 0.60, it drove the pixel
      // deep enough that the post chain's shadow lift — a pale LAVENDER, added in
      // proportion to how dark a pixel is — became the dominant term in it.
      // Measured: shots/tracks-grass.png read #A78586 and #AC8786 inside the
      // corridor, and shots/lagoon-morning.png #937B94, hue 297. A mauve stain
      // smeared across a green hillside, which is not a tyre mark.
      //
      // So the disturbed colour is pulled toward the biome's own SHADOW STOP
      // instead of toward nothing. That stop is authored, coloured and lifted
      // (ART_BIBLE §2), so a rut is now the same material in its own shade — and
      // the 0.22 floor means it can never get dark enough for the lift to take
      // over again.
      const darkened = vec3(albedo.mul(dark.oneMinus().max(0.22)))
      let disturbed: Node<'vec3'> = vec3(mix(
        darkened, vec3(shade.mul(0.85)), dfm.darken.mul(0.45),
      ))
      // "Deep ruts expose dirt and rock" — and on terrain the thing underneath
      // is the biome's own slope material, which is already sampled.
      disturbed = vec3(mix(
        disturbed, vec3(cliff.mul(0.6)),
        saturate(dfm.expose.mul(dfm.depth.mul(2.4))),
      ))
      // `setSaturation`, not `gradeSaturation`: the response table's `chroma` is
      // BELOW 1 on five of its seven surfaces (grass 0.88, snow 0.78, mud 0.74,
      // desert 0.90, dry sand 0.92) and `gradeSaturation` is the identity for any
      // amount under 1, so "chroma multiplier ... <1 washes out (snow)" — the
      // authored, documented behaviour of that column — has never once run.
      disturbed = vec3(setSaturation(disturbed, dfm.chroma))
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
    // 0.12, and the shade's LIFT now comes mostly from the sky term below, and the alpine is what set it. ART_BIBLE §4 authors
    // snow shadow at #A8C4DC and says the biome is "HIGH KEY, LOW CONTRAST ...
    // the whole biome sits in the top third of the value range. Resist adding
    // contrast to 'make it read'." An authored stop at luma 0.72 was arriving on
    // screen at p05 0.179 — a navy wall — because a fragment inside a cast shadow
    // gets `ambient + 0.12 x sun` and nothing else. The shadow gate agrees
    // independently: five shots CRUSHED against a 0.299 floor, and shadow/lit
    // ratios of 0.205-0.359 against a 0.364 one.
    const FILL = float(0.12)
    const direct = vec3(
      atmosphere.sunColorNode.mul(mix(toMid.mul(0.36).add(FILL), float(1), toLit)),
    )
    // ── the shade lift is SKY-coloured, not sun-coloured ─────────────────────
    //
    // A warm fill floor lifts a shaded pixel's VALUE and costs it CHROMA, because
    // adding near-white light to a saturated blue moves it toward grey. Both
    // properties are gated and they were trading one for one: at a fill of 0.17
    // the shadow gate went green and the palette gate reported "undersaturated"
    // with the darks' saturation at 0.362 against the reference's 0.637; pulling
    // the fill back reversed both.
    //
    // Extra AMBIENT in the shade breaks the trade, because the ambient is the sky
    // irradiance LUT — it is already the hue ART_BIBLE §2 wants the shade tinted
    // toward, and ART_BIBLE §4's measured grass shadow (#3B6C9A, H206) is that
    // hue. So the shaded stop gets up to 60% more sky and the warm floor comes
    // back down to 0.12: value up, chroma up, and the lit half of the frame
    // untouched because the weight is `1 - toMid`.
    //
    // Physically this is the sky's contribution being under-counted in shade
    // rather than over-counted: a hollow sees less sky than a ridge, but a
    // diffuse-only model with one irradiance sample has no way to give a
    // sun-facing slope in shadow the extra bounce it actually receives from the
    // sunlit ground around it.
    // CHROMA-CAPPED, or the lift becomes the shade's hue instead of its value.
    // Raw sky irradiance is nearly pure blue at noon — Rec.709 weights blue at
    // 0.0722, so its peak channel runs ~2.7x its own luminance — and adding 60%
    // more of it to the shaded stop took the ground's shadow to H205 while the lit
    // grass sat at H88. That is a 117-degree gap where ART_BIBLE §2 asks for about
    // 40 ("tinted toward the sky hue ... stays in the material family") and
    // tools/complaints.mjs gates 60. The `ambient` term above still carries the
    // full sky tint; this term exists to carry VALUE, so it is capped to a peak
    // 1.15x its luminance and lifts without recolouring. Same operator and the
    // same reasoning as `skyShadow` a few lines up.
    const shadeLift = vec3(
      clampChroma(ambient, 1.15).mul(toMid.oneMinus().mul(0.60)),
    )
    let color: Node<'vec3'> = vec3(albedo.mul(ambient.add(shadeLift).add(direct)))

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
