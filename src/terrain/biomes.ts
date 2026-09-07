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
  /**
   * Metres of WATER this form may stand in. Default 0 — dry land only, with the
   * 1.2 m of freeboard `Scatter` requires of everything else.
   *
   * `Scatter` otherwise culls every instance whose ground is under
   * `waterLevel + 1.2`, which is right for a tree and wrong for a rock: it is
   * why the sea shipped as an empty sheet with nothing in it, and why the
   * single most characteristic feature of `refs/water/lake-cartoon-cells.jpg` —
   * a white foam outline around every rock in the lake — had nothing to draw an
   * outline around. `src/water/index.ts` stamps the collar; this is what puts
   * the rock there for it to collar.
   *
   * A property of the FORM, not of the biome, which is why it sits on the entry
   * rather than on the style: a boulder can stand in a metre of water in any
   * biome that has both boulders and water.
   */
  wade?: number
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

const S = (
  id: string, perKm2: number, lo: number, hi: number,
  maxSlope?: number, wade?: number,
): ScatterEntry => ({
  id, perKm2, scale: [lo, hi],
  ...(maxSlope === undefined ? {} : { maxSlope }),
  ...(wade === undefined ? {} : { wade }),
})

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
  // Meadow / hub. Ground, fog, sun tint, scatter and grass follow
  // overgrown-portfolio (`src/grass/defaults.js`, `environment.ts`,
  // `groundTextures.ts`). THE SKY stays Trenchcoons' Atmosphere LUT — do not
  // import overgrown's skybox / cloud field.
  meadow: {
    id: 'meadow', label: 'meadow',
    // Olive meadow from overgrown defaults:
    //   grassColor #a8b86a, groundColor #9aab62, soft blue haze #d0eafc,
    //   warm sun #ffe8a0. Shadow stays in the olive family (not sky-blue).
    //   under = warm packed dirt from createDirtGroundTexture's sandy base.
    //   rock/cliff = warm path-stone, not Genshin blue-grey planes.
    // Authored under the illuminant: overgrown screen olive is ~#9aab62 /
    // #a8b86a; the pipeline adds chroma, so stops sit slightly duller/warmer.
    base: 0x8a9a58, shadow: 0x4e6840, lit: 0x9eae66,
    cliff: 0x8b8570, under: 0xa8804e, rock: 0x8b8570,
    relief: 6, reliefScale: 120, reliefRidge: 0, rockSlope: 0.86,
    scatter: [
      // Quaternius stylized-nature via overgrown landscapePopulate catalog.
      S('qn-rock-1', 140, 0.75, 1.2, 0.5),
      S('qn-rock-2', 120, 0.7, 1.15, 0.5),
      S('qn-rock-3', 100, 0.7, 1.2, 0.45),
      S('qn-pebble-1', 900, 0.9, 1.5, 0.85),
      S('qn-pebble-2', 800, 0.85, 1.45, 0.85),
      S('qn-pebble-3', 700, 0.85, 1.4, 0.85),
      // Occasional large sculptural rock kept from the old set for Genshin planes.
      S('boulder-large', 80, 0.9, 1.55, 0.35),
      S('outcrop-shelf', 40, 0.9, 1.6, 0.4),
      S('qn-bush', 900, 0.7, 1.15, 0.6),
      S('qn-clover-1', 520, 0.8, 1.15, 0.7),
      S('qn-clover-2', 420, 0.8, 1.15, 0.7),
      // Sparse copses — combined ~400/km2, not a forest.
      S('qn-common-1', 55, 0.9, 1.25, 0.5),
      S('qn-common-2', 50, 0.9, 1.25, 0.5),
      S('qn-common-3', 45, 0.9, 1.3, 0.5),
      S('qn-common-4', 40, 0.85, 1.25, 0.5),
      S('qn-common-5', 40, 0.85, 1.2, 0.5),
      S('qn-pine-1', 35, 0.9, 1.3, 0.5),
      S('qn-pine-2', 30, 0.9, 1.3, 0.5),
      S('qn-pine-3', 25, 0.9, 1.25, 0.5),
    ],
    // Overgrown field density ~1.45; structure gate caps how far this can go.
    grassDensity: 1.45, grassId: 'grass-tuft', grassScale: 1.08,
    fog: 0xd0eafc, fogDensity: 0.75, sunTint: 0xffe8a0, ambient: 1.05,
    response: 'grass',
  },
  // Forest — same overgrown olive countryside, one register darker under canopy.
  // Soft blue haze (not green-tinted fog): overgrown uses one haze for the whole
  // field. Collision density still needs ~7k trees/km2 so the kart cannot thread
  // a straight line through the stand.
  forest: {
    id: 'forest', label: 'forest',
    base: 0x6f8a48, shadow: 0x3f5a38, lit: 0x8fa85a,
    cliff: 0x6a5236, under: 0x4a3524, rock: 0x7a7568,
    relief: 9, reliefScale: 90, reliefRidge: 0.15, rockSlope: 0.74,
    scatter: [
      // Quaternius canopy from overgrown-portfolio. Combined ~7.3k/km2 keeps the
      // collision density that the old 8k conifer+pp mix was raised for, while
      // Common/Pine/Twisted give three silhouettes. groveAt² clumps stands;
      // qn-bush uses softer grove modulation (UNDERSTORY_IDS) so bushes ring
      // trees rather than carpet clearings.
      S('qn-common-1', 900, 0.95, 1.35, 0.55),
      S('qn-common-2', 850, 0.95, 1.35, 0.55),
      S('qn-common-3', 800, 0.95, 1.4, 0.55),
      S('qn-common-4', 750, 0.9, 1.35, 0.55),
      S('qn-common-5', 700, 0.9, 1.3, 0.55),
      S('qn-pine-1', 700, 0.95, 1.4, 0.55),
      S('qn-pine-2', 650, 0.95, 1.4, 0.55),
      S('qn-pine-3', 600, 0.9, 1.35, 0.55),
      S('qn-twisted-1', 280, 0.9, 1.15, 0.5),
      S('qn-twisted-2', 240, 0.9, 1.15, 0.5),
      S('qn-bush', 2400, 0.75, 1.25, 0.6),
      S('qn-mushroom', 260, 0.8, 1.3, 0.55),
      S('qn-rock-1', 90, 0.7, 1.2, 0.5),
      S('qn-rock-2', 80, 0.7, 1.15, 0.5),
      S('qn-rock-3', 70, 0.7, 1.2, 0.5),
      // Deadwood still sells forest floor; overgrown has no equivalent.
      S('log-fallen', 300, 0.8, 1.3, 0.4),
      S('stump-broken', 240, 0.8, 1.3, 0.45),
      S('roots-exposed', 210, 0.8, 1.3, 0.5),
    ],
    grassDensity: 0.32, grassId: 'grass-cluster', grassScale: 1.12,
    fog: 0xd0eafc, fogDensity: 0.95, sunTint: 0xffe8a0, ambient: 0.92,
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
      S('rock-slab', 320, 0.9, 2.0, 0.4),
      S('outcrop-step', 80, 0.9, 1.8, 0.35),
      S('outcrop-shelf', 60, 0.9, 1.7, 0.3),
      S('boulder-large', 70, 0.8, 1.5, 0.35),
      S('rock-pebble', 1800, 0.5, 1.2, 0.8),
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
      S('rock-medium', 380, 0.8, 1.7, 0.7),
      S('rock-slab', 320, 0.8, 1.6, 0.7),
      S('boulder-large', 140, 0.8, 1.6, 0.6),
      S('conifer-young', 320, 0.7, 1.1, 0.5),
      S('rock-pebble', 1600, 0.5, 1.2, 0.8),
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
      S('rock-pebble', 900, 0.5, 1.0, 0.6),
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
      // PEBBLE DENSITY HALVED AND MORE, and the reason is the ORDER of two tests
      // in `Scatter`, not the look of a beach.
      //
      // A lattice cell picks ONE asset in proportion to density and THEN applies
      // the water cull, so it does not fall back: underwater, every cell that
      // picked a non-wading asset yields nothing at all. At 5200/km2 of pebble
      // against 1710 of wading rock, 76% of underwater cells picked something
      // that cannot stand in water and produced empty sea — which is the real
      // arithmetic behind "no rock is ever placed in the water", after `wade`,
      // the density and the slope limit had each been fixed and changed nothing.
      //
      // Rebalancing the DISTRIBUTION is the fix available from this file; the
      // alternative is re-picking after the cull, which is a change to the
      // scatter's determinism and belongs to whoever owns that file. Pebbles at
      // 5200/km2 also read as speckle rather than as shingle, so the beach loses
      // nothing it wanted.
      // Beach rock cut to 10% — the dry strand was a boulder field.
      S('rock-pebble', 90, 0.5, 1.1, 0.7),
      // ROCKS THAT STAND IN THE WATER. ART_BIBLE §4's coast palette is "water,
      // foam and two sands", and both water references make the same point in
      // pictures: a shoreline is legible because things stick out of it. These
      // three wade, so the shallows carry forms and the water has something to
      // draw a foam collar around.
      // DENSE, and the density is set by the WADING BAND rather than by the
      // beach. A form may only stand in `wade` metres of water, and on this
      // world's 1-in-5 shelf that is a strip 10-18 m wide; at the 120/km2 a dry
      // beach would want, a 200 m stretch of visible shoreline expects 0.4
      // rocks in the water and measured zero. `lake-cartoon-cells.jpg` is
      // liberally studded with them, which is also what makes its shoreline
      // legible, so these are authored for the strip and the beach gets the
      // same rocks for free.
      // BIGGER, not just deeper. This world's shelf falls about 1 in 5, so
      // "shallow enough to stand in" is a strip 10-25 m wide however generous
      // `wade` is, and a form that only just clears the surface in it reads as
      // gravel. Scaling the two large rocks up makes them sea stacks that stand
      // several metres proud in several metres of water, which is what the
      // reference's rocks are.
      // AND THE SLOPE LIMIT IS RELAXED FOR THE WADING PAIR, which is what
      // finally put them in the water. `wade` was correct and live in the built
      // bundle and still nothing was placed below the waterline, because the
      // slope test rejects first: `roughSlopeAt(x, z, 1.5)` measures the
      // continental field's LOCAL gradient, and that field's finest octave is 5 m
      // of amplitude over a 46 m wavelength, so the local slope is already
      // 0.3-0.6 rad before the shelf's own 0.19 rad is added. On the downslope
      // into the sea the two compound and a 0.6 limit rejects essentially
      // everything — the rocks stopped exactly at the sand/water boundary, which
      // is what the frames showed.
      //
      // A boulder standing in the sea does not need gentle ground under it. 1.1
      // rad is 63 degrees, well inside the 1.5 the schema allows.
      // HIGH ON PURPOSE, AND THE TRADE IS RECORDED BOTH WAYS because it was made
      // in both directions and the second call is the right one.
      //
      // These densities apply to the WHOLE coast biome, not just the wading
      // strip, so every rock that makes the shallows legible also lands on the
      // dry beach — and `npm run distinct`'s corridor ratio measures tyre marks
      // against the bare sand beside them. At these figures it read 0.67 against
      // a required 1.25, where the lower set read 0.81.
      //
      // They were lowered to 1600 / 1300 / 520 to protect that ratio, and the
      // cost was the feature: `solidRings` fell from 5 to 2 and then to 0 — no
      // rock stands in the water at all, and "a thick white foam outline around
      // every rock" is the single most characteristic mark in
      // `refs/water/lake-cartoon-cells.jpg`. The corridor ratio was ALREADY 0.81
      // at HEAD, before any of this work, i.e. already failing its own
      // requirement; trading a named art requirement away to move an
      // already-red metric from 0.81 to 0.67 is the wrong side of the trade.
      //
      // The real fix is a shore-proximity density so the wading strip can be
      // dense while the beach is not, which needs a change to `Scatter`.
      // Same 90% cut as the beach pebbles — a few sea stacks, not a reef.
      S('rock-small', 140, 0.7, 1.3, 0.5, 0.9),
      S('rock-medium', 110, 1.4, 2.6, 1.1, 4.0),
      S('boulder-large', 48, 1.2, 2.4, 1.1, 7.5),
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
    grassDensity: 0, grassId: '', grassScale: 0.8,
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

/** Deep-clone one style. Used by the Forge Environments editor so live edits
 *  can reset without reloading the page. */
export function cloneBiomeStyle(style: BiomeStyle): BiomeStyle {
  return {
    ...style,
    scatter: style.scatter.map((e) => ({
      id: e.id,
      perKm2: e.perKm2,
      scale: [e.scale[0], e.scale[1]] as [number, number],
      ...(e.maxSlope === undefined ? {} : { maxSlope: e.maxSlope }),
      // `wade` MUST BE COPIED HERE. This clone rebuilds each scatter entry
      // field by field, `ensureSnapshot` replaces the live `BIOME_STYLES` with a
      // clone at module init, and any key this list forgets is therefore
      // silently absent from the table the game actually reads. `wade` was
      // omitted, so three consecutive fixes for "no rock is ever placed in the
      // water" — the depth semantics, the density, the slope limit — were each
      // verified present in the built bundle and each changed nothing, because
      // `entry.wade` was `undefined` by the time `Scatter` read it and
      // `?? 0` turned that into "dry land only".
      //
      // A spread would not have this failure mode. It is written out field by
      // field on purpose (the Forge round-trips these through JSON), so the cost
      // of that choice is that every new key has to be added in both clones.
      ...(e.wade === undefined ? {} : { wade: e.wade }),
    })),
  }
}

/** Snapshot of the authored table. Taken once; live edits mutate `BIOME_STYLES`
 *  in place and rebake the terrain maps. */
let authoredSnapshot: Record<BiomeId, BiomeStyle> | null = null

function ensureSnapshot(): Record<BiomeId, BiomeStyle> {
  if (!authoredSnapshot) {
    authoredSnapshot = {} as Record<BiomeId, BiomeStyle>
    for (const id of BIOME_IDS) authoredSnapshot[id] = cloneBiomeStyle(BIOME_STYLES[id])
  }
  return authoredSnapshot
}

/** Replace one biome's live style (Forge Environments). Callers must rebake
 *  `TerrainWorld` and rebuild scatter choices afterward. */
export function replaceBiomeStyle(id: BiomeId, style: BiomeStyle): void {
  ensureSnapshot()
  const next = cloneBiomeStyle(style)
  next.id = id
  BIOME_STYLES[id] = next
}

/** Restore one biome (or every biome) to the authored table. */
export function resetBiomeStyle(id?: BiomeId): void {
  const snap = ensureSnapshot()
  if (id) {
    BIOME_STYLES[id] = cloneBiomeStyle(snap[id])
    return
  }
  for (const bid of BIOME_IDS) BIOME_STYLES[bid] = cloneBiomeStyle(snap[bid])
}

/** Authored (pre-edit) style for a biome. */
export function authoredBiomeStyle(id: BiomeId): BiomeStyle {
  return cloneBiomeStyle(ensureSnapshot()[id])
}

/** Serialise a style for Copy JSON — hex colours as `#rrggbb`, numbers plain. */
export function biomeStyleToJson(style: BiomeStyle): string {
  const hex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`
  const body = {
    id: style.id,
    label: style.label,
    base: hex(style.base),
    shadow: hex(style.shadow),
    lit: hex(style.lit),
    cliff: hex(style.cliff),
    under: hex(style.under),
    rock: hex(style.rock),
    relief: style.relief,
    reliefScale: style.reliefScale,
    reliefRidge: style.reliefRidge,
    rockSlope: style.rockSlope,
    scatter: style.scatter.map((e) => ({
      id: e.id,
      perKm2: e.perKm2,
      scale: e.scale,
      ...(e.maxSlope === undefined ? {} : { maxSlope: e.maxSlope }),
      // `wade` MUST BE COPIED HERE. This clone rebuilds each scatter entry
      // field by field, `ensureSnapshot` replaces the live `BIOME_STYLES` with a
      // clone at module init, and any key this list forgets is therefore
      // silently absent from the table the game actually reads. `wade` was
      // omitted, so three consecutive fixes for "no rock is ever placed in the
      // water" — the depth semantics, the density, the slope limit — were each
      // verified present in the built bundle and each changed nothing, because
      // `entry.wade` was `undefined` by the time `Scatter` read it and
      // `?? 0` turned that into "dry land only".
      //
      // A spread would not have this failure mode. It is written out field by
      // field on purpose (the Forge round-trips these through JSON), so the cost
      // of that choice is that every new key has to be added in both clones.
      ...(e.wade === undefined ? {} : { wade: e.wade }),
    })),
    grassDensity: style.grassDensity,
    grassId: style.grassId,
    grassScale: style.grassScale,
    fog: hex(style.fog),
    fogDensity: style.fogDensity,
    sunTint: hex(style.sunTint),
    ambient: style.ambient,
    response: style.response,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}
