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
  /** Metres of relief the biome adds to the base heightfield. */
  relief: number
  /** Feature size of that relief, metres. Dunes are long, alpine ridges short. */
  reliefScale: number
  /** 0 = smooth rolling, 1 = ridged and creased. ART_BIBLE alpine wants ridges. */
  reliefRidge: number

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
    base: 0x6fb03f, shadow: 0x3f7a3e, lit: 0xb8e84f,
    cliff: 0x8b6a45, under: 0x8b6a45,
    relief: 6, reliefScale: 120, reliefRidge: 0,
    scatter: [
      S('rock-medium', 420, 0.8, 1.6, 0.5),
      S('rock-small', 2600, 0.6, 1.3, 0.6),
      S('rock-pebble', 9000, 0.5, 1.3, 0.8),
      S('boulder-large', 90, 0.8, 1.4, 0.35),
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
    base: 0x4e7f33, shadow: 0x2f5f2e, lit: 0x8fc24a,
    cliff: 0x6a5236, under: 0x4a3524,
    relief: 9, reliefScale: 90, reliefRidge: 0.15,
    scatter: [
      S('conifer-tall', 5000, 0.85, 1.5, 0.55),
      S('conifer-young', 3000, 0.8, 1.4, 0.6),
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
    cliff: 0xb87a4f, under: 0xa86a44,
    // Long-wavelength dunes: the desert's relief is the biggest of any biome
    // and also the smoothest, which is what makes it read as sand rather than
    // as brown grassland.
    relief: 14, reliefScale: 260, reliefRidge: 0,
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
    cliff: 0x3a3f42, under: 0x6f93a8,
    relief: 26, reliefScale: 150, reliefRidge: 0.75,
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
    base: 0x5a7a4a, shadow: 0x3d5236, lit: 0x9fb855,
    cliff: 0x5a4632, under: 0x332618,
    relief: 2.5, reliefScale: 180, reliefRidge: 0,
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
    cliff: 0xc9a96f, under: 0xa88a58,
    relief: 1.5, reliefScale: 90, reliefRidge: 0,
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
