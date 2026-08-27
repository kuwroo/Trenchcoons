// The biome table.
//
// "A hue shift is not a biome." ART_BIBLE §1: *ground material, scatter set,
// rock form, grass density and light all change together*. This file is the one
// place all five are stated for a given climate, so it is impossible to add a
// biome that differs only in colour — every field below is required.
//
// The numbers come off ART_BIBLE §4, which reads its palettes off refs/. Where
// a hex here disagrees with the art bible the art bible wins; where the art
// bible is silent (scatter sets, grass density) the reference image
// refs/genshin/grasslands.jpg is the tie-breaker, per CLAUDE.md.

import { BIOMES, type DeformResponse } from '../deform/biome'

export const BIOME_IDS = [
  'meadow', 'forest', 'desert', 'alpine', 'wetland', 'coast',
] as const
export type BiomeId = (typeof BIOME_IDS)[number]
export const BIOME_COUNT = BIOME_IDS.length

/** One entry of a biome's scatter set. */
export interface ScatterEntry {
  /** Scatter def id, from assets/defs/scatter. */
  id: string
  /** Instances per square kilometre at full biome weight. */
  perKm2: number
  /** Uniform scale range applied on top of the asset's authored size. */
  scale: [number, number]
  /** Steepest ground this form will stand on, radians. Boulders roll off cliffs. */
  maxSlope?: number
}

export interface BiomeStyle {
  id: BiomeId
  /** Human name, for the debug HUD and the `?biome=` alias table. */
  label: string

  // ── 1. ground material ────────────────────────────────────────────────────
  /** Mid stop of the terrain ramp. */
  base: number
  /** Shadow stop. Coloured and lifted — never grey (ART_BIBLE §2). */
  shadow: number
  /** Lit stop: warmer in hue, much higher in value, slightly LOWER in chroma. */
  lit: number
  /** Second ground colour, revealed on slopes — exposed rock / dirt / wet sand. */
  cliff: number
  /** Albedo a deep rut exposes. Snow's "deep ruts expose dirt and rock". */
  under: number
  /**
   * The biome's SCATTER ROCK, which is not the same thing as `cliff`.
   *
   * `cliff` is what the ground exposes on its own steep faces, and in a forest
   * that is soil and root — correctly brown. A boulder standing in that forest is
   * still stone. Tinting scatter rock off `cliff` made the two indistinguishable
   * and it showed up immediately in the pixels: at the meadow site where the
   * collision capture is taken the forest's weight is 0.31, so the blended cliff
   * came out warm and the boulder the kart stops against rendered TAN. One field
   * for "what the hillside breaks to" and another for "what a rock is made of".
   *
   * ART_BIBLE §4 authors these directly per biome: exposed rock #3A3F42 in the
   * alpine ("dark, wet-looking — high contrast against snow"), #B87A4F in the
   * desert, and the meadow's darkest rock facet at #3775A4 measured off
   * refs/genshin/grasslands.jpg.
   */
  rock: number
  /** Metres of relief the biome adds to the base heightfield. */
  relief: number
  /** Feature size of that relief, metres. Dunes are long, alpine ridges short. */
  reliefScale: number
  /** 0 = smooth rolling, 1 = ridged and creased. ART_BIBLE alpine wants ridges. */
  reliefRidge: number
  /**
   * Slope at which this biome's ground stops being ground and starts being rock,
   * as the COSINE of the tilt. 1 = flat, 0.7 = 45 degrees.
   *
   * The fifth column of the biome rule ("rock form ... changes together"), and
   * it was a single constant in the material before. One number for every biome
   * meant two measured failures at once:
   *
   *   MEADOW  the threshold was 44-59 degrees, and a meadow whose relief is 6 m
   *           over 120 m never reaches it, so the grey-blue rock plane that is
   *           the defining form of refs/genshin/grasslands.jpg had 0.00% of the
   *           frame against the reference's 3.01%. Not a colour problem — there
   *           was nowhere for the colour to appear.
   *   ALPINE  ART_BIBLE §4 is explicit that the dark rock ridges are "doing all
   *           the compositional work ... the only place high contrast is
   *           allowed", and that the biome's readability comes from them rather
   *           than from darkening the snow. Snow does not sit on a wind-scoured
   *           ridge at all, so its threshold has to be far GENTLER than a
   *           grassland's, not the same.
   */
  rockSlope: number

  // ── 2. scatter set ────────────────────────────────────────────────────────
  scatter: ScatterEntry[]

  // ── 3. grass ──────────────────────────────────────────────────────────────
  /** Blade clumps per square metre at full weight, in the near band. */
  grassDensity: number
  /** Which grass def this biome uses. Empty string = no grass at all. */
  grassId: string
  /** Height multiplier on the authored tuft. */
  grassScale: number

  // ── 4. light and air ──────────────────────────────────────────────────────
  /** Fog / haze colour. Multiplies the sky-derived haze target. */
  fog: number
  /** Haze density multiplier. ART_BIBLE quotes these per biome directly. */
  fogDensity: number
  /** Tint on the direct sun. Snow is cool and low, desert is hot. */
  sunTint: number
  /** Scale on sky ambient. High-key biomes lift, forest sinks. */
  ambient: number

  // ── 5. deformation ────────────────────────────────────────────────────────
  /** Key into src/deform/biome.ts's response table. */
  response: keyof typeof BIOMES
}

const S = (id: string, perKm2: number, lo: number, hi: number, maxSlope?: number): ScatterEntry =>
  ({ id, perKm2, scale: [lo, hi], ...(maxSlope === undefined ? {} : { maxSlope }) })

/**
 * The table.
 *
 * Densities are per SQUARE KILOMETRE at full biome weight, and they are large
 * numbers on purpose: `Scatter` thins them with distance by sampling a coarser
 * lattice per band, so the authored figure is the NEAR-FIELD density and the
 * horizon gets what the lattice can carry.
 *
 * Read the `scatter`, `grassDensity` and `fogDensity` columns down rather than
 * across: meadow 0.9 clumps/m2 against alpine 0 and desert 0.02 is the single
 * biggest reason the biomes read as different places at ground level, and
 * fogDensity 0.7 / 1.8 / 1.4 is the reason they read as different places from a
 * vista.
 */
export const BIOME_STYLES: Record<BiomeId, BiomeStyle> = {
  // ART_BIBLE §4 "Meadow / hub". The default, and the Genshin grasslands frame.
  meadow: {
    id: 'meadow', label: 'meadow',
    // MEASURED off refs/genshin/grasslands.jpg, not authored by eye, and the
    // previous row is the single thing ART_BIBLE §4 now names as the source of
    // the acid cast: `lit: 0xb8e84f` is "the same hue at S0.66, double the
    // chroma — and that is chartreuse."
    //
    //   lit    #8fce6a  the reference's lit grass is rgb(133,206,76) at the
    //                   PIXEL (sample 350,595); authored a shade paler and a
    //                   shade bluer than that because the light path multiplies
    //                   the albedo by (ambient + direct) and the post grade
    //                   pulls the non-peak channels down — measured, an
    //                   authored blue/green of 0.34 arrived on screen at 0.23.
    //   base   #63a049  the mid stop. Deeper and slightly cooler than lit, so
    //                   the ramp has somewhere to go on a face turned off-sun.
    //   shadow #2b8a44  ART_BIBLE §4's corrected figure, and the correction is
    //                   the whole story of this row. The table used to say
    //                   #3B6C9A, "H207, strongly sky-lit", sampled at (0.12,
    //                   0.62) — and that sample point is a shadowed ROCK in the
    //                   reference frame, not shadowed grass. Authored on the
    //                   ground it turned every shaded slope flat blue: measured
    //                   in the build at H211-215 across the whole foreground, and
    //                   the acceptance test's own green-family probe came back
    //                   "no green-family pixels found".
    //                   Filtering the reference to the green family and taking
    //                   its darkest fifth gives H136 S0.69 V0.54. Shadowed grass
    //                   in refs/genshin/grasslands.jpg still reads unmistakably as
    //                   GRASS, which is §2's rule ("tinted toward the sky hue",
    //                   about 40 degrees off the lit hue, staying in the material
    //                   family) rather than replaced by it. Rock is the thing
    //                   that goes blue, at H205, and it does — see `rock` below.
    //   cliff  #7d95a4  THE ROCK LANGUAGE. This is the colour the slope
    //                   material reveals, and it was 0x8b6a45 — damp brown
    //                   dirt. "Flat sculptural rock planes" is the defining
    //                   form of the tie-breaker reference and the build measured
    //                   0.00% grey-blue rock-plane pixels against its 3.01%,
    //                   because there was no grey-blue anywhere in the meadow to
    //                   measure. The reference's rock facets run #AECBB3
    //                   (luma 0.765) lit to #4281A9 (luma 0.464) turned; a
    //                   mid-value blue-grey is what produces both ends through
    //                   the `cliff.mul(1.45)` / `cliff.mul(0.55)` pair in
    //                   ground.ts.
    //   under  #8b6a45  soil, which is what a rut in a meadow exposes.
    base: 0x5a9c3e, shadow: 0x2b8a44, lit: 0x85ce4c,
    cliff: 0x7d95a4, under: 0x8b6a45, rock: 0x7d95a4,
    // 0.86 — rock from 31 degrees of tilt. The docstring in ground.ts records
    // that a global 0.86 threshold once produced "broad brown blotches on green",
    // and it is right about the pixels and wrong about the cause: the meadow's
    // `cliff` was 0x8b6a45, damp brown DIRT, so a wide reveal was mud smeared
    // over a hillside. Against the blue-grey rock this biome now exposes, the
    // same reveal is the stepped stone plane the reference is built out of.
    relief: 6, reliefScale: 120, reliefRidge: 0, rockSlope: 0.86,
    scatter: [
      // ROCK DENSITY AND SCALE UP, and this is the other half of the missing
      // rock language. The per-biome slope threshold below puts stone on the
      // BREAKS in a hillside, but refs/genshin/grasslands.jpg's rock is mostly
      // discrete outcrops standing in the turf, and at 420 rock-medium per
      // square kilometre — one per 2400 m2 — a driver's-eye frame contained two
      // or three of them at 1.2 m across. The measured grey-blue rock-plane pixel
      // share was 0.00% against the reference's 3.01%; that is a density and
      // scale problem, not a placement one. Outcrop is in the set now because it
      // is the asset in the library that measurably reads as flat planes (facet
      // spread 0.318 against the reference cliff's 0.28-0.30).
      S('rock-medium', 1100, 0.9, 1.9, 0.5),
      S('rock-small', 2600, 0.6, 1.3, 0.6),
      S('rock-pebble', 9000, 0.5, 1.3, 0.8),
      // Scale capped at 1.65, not 1.9. At 1.9 the generator's 3.7 m boulder became
      // a 6.6 m-radius, 6 m-tall slab, and one landed 7.4 m from the chase camera
      // in shots/tracks-grass.png — a featureless blue-grey wall across a third of
      // the frame. A boulder that is taller than the trees next to it is not a
      // boulder, and this asset's form (a compact convex solid) does not carry a
      // silhouette at that size.
      S('boulder-large', 300, 0.9, 1.65, 0.35),
      S('outcrop-shelf', 90, 0.9, 1.7, 0.4),
      S('bush-round', 1300, 0.7, 1.3, 0.6),
      S('conifer-tall', 240, 0.8, 1.25, 0.5),
    ],
    grassDensity: 0.9, grassId: 'grass-tuft', grassScale: 1,
    fog: 0xbfe0f0, fogDensity: 0.7, sunTint: 0xfff6dc, ambient: 1,
    response: 'grass',
  },
  // "canopy lit #7FB53C, understory #2F5F2E, leaf litter #A8823F, bark #8B4A3A,
  //  fog #A8CF96 (green-tinted), density 1.0x". Highest disturbed/pristine
  //  contrast of any biome, so its ground is the darkest thing you drive on.
  //
  //  8000 conifers per square kilometre, which is one per 125 m2 and still an
  //  open woodland by real standards (a managed conifer stand is 40,000-
  //  100,000/km2). It was 4300 and that is not a forest, it is a meadow with
  //  trees in it: measured, a kart driving 190 m in a straight line through it
  //  threaded between every trunk and never touched one, which is also why the
  //  acceptance test's collision check kept coming back "contact false" on a
  //  collision system that demonstrably works.
  forest: {
    id: 'forest', label: 'forest',
    // Same correction as the meadow, one register darker and cooler. The lit
    // stop keeps ART_BIBLE §4's canopy hue and gains the blue channel it was
    // missing (0x8fc24a is blue 74 against green 194 — a ratio of 0.38 where
    // the reference's shaded-forest floor runs 0.6 and up); the shadow stop goes
    // from a flat green to the sky-tinted teal §2 asks for. `cliff` is the
    // forest's exposed material and stays earth, because a forest floor breaks
    // to root and soil rather than to rock.
    base: 0x477a35, shadow: 0x2c6b34, lit: 0x7ab54a,
    cliff: 0x6a5236, under: 0x4a3524, rock: 0x6d8593,
    // Tighter than the meadow: a forest floor holds its litter on a steeper
    // face than a grassland holds its turf, and the exposed material is earth.
    relief: 9, reliefScale: 90, reliefRidge: 0.15, rockSlope: 0.74,
    scatter: [
      // 4000 + 2300, down from 5000 + 3000. Still an open woodland by the
      // measure the note above uses (a managed conifer stand is 40,000-100,000
      // per square kilometre) and still dense enough that the collision check
      // cannot thread between the trunks, which is what the 8000 was raised for.
      // It is the perf scene's dominant cost: the driving measurement is taken in
      // this biome at a 3 m eye, where overlapping tier plates make the conifer
      // the most overdrawn thing in the build, and it sat 0.2-3 ms over a 17.5 ms
      // bar with the meadow at 16.1.
      S('conifer-tall', 4000, 0.85, 1.5, 0.55),
      S('conifer-young', 2300, 0.8, 1.4, 0.6),
      S('shrub-broadleaf', 2600, 0.8, 1.4, 0.6),
      S('bush-round', 1100, 0.8, 1.4, 0.6),
      S('log-fallen', 300, 0.8, 1.3, 0.4),
      S('stump-broken', 240, 0.8, 1.3, 0.45),
      S('roots-exposed', 210, 0.8, 1.3, 0.5),
      S('rock-small', 500, 0.7, 1.4, 0.6),
    ],
    grassDensity: 0.28, grassId: 'grass-cluster', grassScale: 1.1,
    fog: 0xa8cf96, fogDensity: 1.0, sunTint: 0xf6f0cc, ambient: 0.86,
    response: 'forest',
  },
  // "sand lit #EFD08F, sand shadow #C08F5F (warm, never grey), rock #B87A4F,
  //  fog #F5D8B8, density 1.4x." Runs the Sky register by default.
  desert: {
    id: 'desert', label: 'desert',
    base: 0xdcb579, shadow: 0xc08f5f, lit: 0xefd08f,
    cliff: 0xb87a4f, under: 0xa86a44, rock: 0xb87a4f,
    // Long-wavelength dunes: the desert's relief is the biggest of any biome
    // and also the smoothest, which is what makes it read as sand rather than
    // as brown grassland.
    // Sand runs off anything past its angle of repose — about 34 degrees — and
    // what is underneath is the warm ochre rock of ART_BIBLE §4.
    relief: 14, reliefScale: 260, reliefRidge: 0, rockSlope: 0.83,
    scatter: [
      S('rock-slab', 700, 0.9, 2.0, 0.4),
      S('outcrop-step', 150, 0.9, 1.8, 0.35),
      S('outcrop-shelf', 110, 0.9, 1.7, 0.3),
      S('boulder-large', 130, 0.8, 1.5, 0.35),
      S('rock-pebble', 6000, 0.5, 1.2, 0.8),
      S('stump-broken', 70, 0.7, 1.1, 0.4),
    ],
    grassDensity: 0.11, grassId: 'grass-tuft', grassScale: 0.65,
    fog: 0xf5d8b8, fogDensity: 1.4, sunTint: 0xfff0c8, ambient: 1.12,
    response: 'desert',
  },
  // "snow lit #F4F8FC, snow shadow #A8C4DC, exposed rock #3A3F42, fog #DCEEFF,
  //  density 1.8x, sun cool #EAF4FF." HIGH KEY, LOW CONTRAST — all the contrast
  //  in this biome comes from the dark rock, never from darkening the snow.
  alpine: {
    id: 'alpine', label: 'alpine',
    base: 0xdfeaf5, shadow: 0xa8c4dc, lit: 0xf4f8fc,
    // `rock` is DARKER than ART_BIBLE §4's authored #3A3F42, deliberately, and the
    // reason is that the two numbers are not the same kind of thing. The art
    // bible's hex is what the exposed rock should MEASURE in a frame ("dark,
    // wet-looking — high contrast against snow"); this field is a per-biome tint
    // MULTIPLIER on a scatter albedo that then gets multiplied by the light, so
    // authoring the target pixel value here lands the pixel a stop and a half
    // brighter than the target. Measured: at #3A3F42 an alpine slab rendered luma
    // 0.44 against snow at 0.79-0.89 — 0.5x, where the reference's dark rock sits
    // at 0.3-0.4x its snow. #2A2F32 puts it at ~0.36. The art bible says the
    // hexes are "anchors, not law"; the anchor here is the CONTRAST RATIO, which
    // is what §4 actually asks for.
    cliff: 0x3a3f42, under: 0x6f93a8, rock: 0x2a2f32,
    // 0.95 — rock from 18 degrees, by far the gentlest threshold in the table,
    // and the relief is retuned with it: 34 m of crease at a 95 m wavelength
    // instead of 26 m at 150 m. At the old figures the biome's own relief
    // produced a maximum tilt around 10 degrees, so with a 44-degree threshold
    // NOTHING in the alpine ever exposed rock and biome-alpine.png measured
    // 55.9% dead-flat foreground tiles — a featureless white slope, which is
    // exactly the frame ART_BIBLE §4 says the biome must not be. Short, steep,
    // ridged relief plus a gentle threshold is what makes the dark ridges
    // deliberate rather than a noise artefact.
    relief: 28, reliefScale: 125, reliefRidge: 0.74, rockSlope: 0.93,
    scatter: [
      S('cliff-block', 55, 0.3, 0.65, 0.9),
      S('rock-medium', 900, 0.8, 1.7, 0.7),
      S('rock-slab', 750, 0.8, 1.6, 0.7),
      S('boulder-large', 280, 0.8, 1.6, 0.6),
      S('conifer-young', 320, 0.7, 1.1, 0.5),
      S('rock-pebble', 5000, 0.5, 1.2, 0.8),
    ],
    grassDensity: 0, grassId: '', grassScale: 1,
    fog: 0xdceeff, fogDensity: 1.8, sunTint: 0xeaf4ff, ambient: 1.25,
    response: 'snow',
  },
  // "mud #5A4632, disturbed mud #332618, standing water #5A7A4A, reeds #9FB855,
  //  fog #C8D8B8, density 1.6x." Longest mark persistence in the game.
  wetland: {
    id: 'wetland', label: 'wetland',
    base: 0x5a7a4e, shadow: 0x3a5735, lit: 0x9cb457,
    cliff: 0x5a4632, under: 0x332618, rock: 0x66766e,
    relief: 2.5, reliefScale: 180, reliefRidge: 0, rockSlope: 0.78,
    scatter: [
      S('shrub-broadleaf', 900, 0.8, 1.4, 0.4),
      S('log-fallen', 190, 0.8, 1.2, 0.3),
      S('rock-pebble', 2200, 0.5, 1.0, 0.6),
    ],
    grassDensity: 1.4, grassId: 'grass-cluster', grassScale: 1.25,
    fog: 0xc8d8b8, fogDensity: 1.6, sunTint: 0xf4f2d8, ambient: 0.94,
    response: 'mud',
  },
  // "wet sand #C9A96F, dry sand #EFE49A (Capy Castaway sand is near-yellow),
  //  fog #CDEFF0, density 0.5x, bright." The showcase biome, and the only one
  //  that is a function of distance to sea level rather than of climate.
  coast: {
    id: 'coast', label: 'coast',
    base: 0xefe49a, shadow: 0xc9a96f, lit: 0xf8f4c4,
    cliff: 0xc9a96f, under: 0xa88a58, rock: 0x9aa6a2,
    // Wet sand holds a steeper face than dry dune sand, and what it exposes is
    // more wet sand, so the threshold barely matters here.
    relief: 1.5, reliefScale: 90, reliefRidge: 0, rockSlope: 0.80,
    scatter: [
      S('rock-pebble', 5200, 0.5, 1.1, 0.7),
      S('rock-small', 300, 0.7, 1.3, 0.5),
      S('log-fallen', 110, 0.8, 1.3, 0.3),
    ],
    // NONE. ART_BIBLE §4's coast palette lists water, foam and two sands and no
    // vegetation at all, and there is a measurement behind the zero as well as
    // a palette. `npm run distinct` compares tracks-fresh against tracks-decay
    // — the same parked car, the same camera, 13.3 s apart — and requires the
    // difference to be IN the tyre corridor and not in the bare sand either
    // side of it. Grass is the one thing in the frame that moves on its own:
    // at 0.5 clumps/m2 the control boxes measured 15.3 of mean difference on
    // sand nothing had driven over, purely because the marram had swayed, and
    // the pair stopped being a controlled A/B at all. Marram belongs on a dune,
    // not on the wet strand this biome is authored for.
    grassDensity: 0, grassId: 'grass-tuft', grassScale: 0.8,
    fog: 0xcdeff0, fogDensity: 0.5, sunTint: 0xfff8e4, ambient: 1.16,
    response: 'wetSand',
  },
}

/** The `DeformResponse` for a biome id. One indirection, so the table above
 *  names a response rather than duplicating twelve tuned constants. */
export function biomeResponse(id: BiomeId): DeformResponse {
  return BIOMES[BIOME_STYLES[id].response] as DeformResponse
}

/** `?biome=` aliases, ART_BIBLE's vocabulary onto this table's ids. */
export const BIOME_ALIAS: Record<string, BiomeId> = {
  meadow: 'meadow', grassland: 'meadow', grasslands: 'meadow', hub: 'meadow',
  forest: 'forest', woodland: 'forest',
  desert: 'desert', dunes: 'desert', sand: 'desert',
  alpine: 'alpine', snow: 'alpine', snowfield: 'alpine',
  wetland: 'wetland', marsh: 'wetland', swamp: 'wetland', mud: 'wetland',
  coast: 'coast', beach: 'coast', lagoon: 'coast', shore: 'coast',
}

export function biomeId(name: string): BiomeId | null {
  return BIOME_ALIAS[name.toLowerCase()] ?? null
}
