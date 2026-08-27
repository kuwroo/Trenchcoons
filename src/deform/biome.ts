// Per-biome deformation response — ART_BIBLE §4, read off the per-biome
// "Deformation:" line in each palette block.
//
// This table IS the spec:
//
//   meadow / hub   shallow ruts, grass flattens and springs back over ~20s
//   coast / lagoon wet sand holds sharp dark tracks (the reference image)
//   forest         marks persist long, highest disturbed/pristine contrast
//   alpine / snow  DEEPEST ruts, up to 0.35 m, refill over ~90s, expose dirt
//   desert         ruts collapse fast (~8s), sand sprays at high slip
//   wetland        essentially permanent until rain, highest friction penalty
//
// One response vector, many consumers — the decay pass, the terrain material and
// the physics coupling all read the SAME numbers, so a surface cannot look
// permanent and drive like sand.
//
// M2's `classify()` is not built yet, so `weightsAt` below is a stand-in that
// knows about the two surfaces the greybox actually has (the meadow ground and
// the sand pan). When the climate fields land, only `weightsAt` changes: every
// consumer already goes through `blend()`.

/** The response of one surface to being driven over. */
export interface DeformResponse {
  /** Deepest rut this surface can hold, metres. ART_BIBLE: snow 0.35. */
  maxDepth: number
  /** Seconds for a full-depth rut to refill to flat. */
  refill: number
  /** Seconds for the disturbance MASK to disappear. Outlives `refill` on snow —
   *  compacted snow is still visible after the rut itself has filled in. */
  maskLife: number
  /**
   * How the refill rate scales with AGE (the A channel).
   *
   * >1 accelerates as the mark ages — dry sand, whose walls stand for a moment
   * and then slump. <1 decelerates — wet sand and snow, which take the mark
   * sharply and then hold it. This is the "decay driven by the age channel"
   * half of the spec; without it every surface fades on the same straight line
   * and the only difference between biomes is how long that line is.
   */
  collapse: number
  /** Wetness/compaction written by a fresh mark, 0..1. */
  wet: number
  /** Seconds for that wetness to dry back off. */
  dry: number
  /** Albedo darkening at mask 1. Wet sand is the extreme; dry sand barely moves. */
  darken: number
  /** Chroma multiplier at mask 1. >1 deepens (wet sand), <1 washes out (snow). */
  chroma: number
  /** How much of the surface's SHADOW stop the disturbed material exposes.
   *  Snow's "deep ruts expose dirt" and the forest's leaf-litter-over-mud. */
  expose: number
  /**
   * Edge hardness of a mark, 0 = collapsed and soft, 1 = razor.
   *
   * Read three times in `DeformField.shade`, and the third is new: it sets the
   * TOE, the gamma, and — cubed, so only a surface that genuinely holds an edge
   * gets any of it — the exponent of the S that turns the stored mask's
   * one-texel bilinear ramp into a boundary. Without that third term a mark
   * fades in over tens of screen pixels however dark its centre is, which is
   * how the last round's tyre tracks came out softer than the ground they were
   * cut into.
   */
  edge: number
  /** Extra rolling resistance inside a full-depth mark, m/s². */
  drag: number
  /** Lateral grip multiplier at mask 1. <1 = the rut is slick. */
  grip: number
}

/**
 * The table. Numbers are authored against ART_BIBLE §4 and then tuned against
 * the captures; the ratios between biomes are the part that matters.
 */
export const BIOMES: Record<string, DeformResponse> = {
  // "shallow ruts, grass flattens and springs back over ~20s; mud shows only
  // under hard cornering." Springs back FAST at first, then lingers — a bent
  // blade recovers most of its angle in the first few seconds.
  //
  // RETUNED, and it is an art-direction call rather than a bug fix — CLAUDE.md
  // says so explicitly: "the fix is an art-direction call about grass, not a
  // bug hunt in src/deform."
  //
  // The authored numbers were maxDepth 0.07 / refill 20 / maskLife 26 /
  // darken 0.44, read straight off "grass flattens then springs back over
  // ~20s". They are a faithful reading of the art bible and they mean a player
  // driving normally never sees a tyre mark: on the default surface the rut is
  // 7 cm and both channels are gone inside half a minute, which is the whole of
  // the user's "dont see tire marks either".
  //
  // What changed and why:
  //   maxDepth 0.07 -> 0.12   still shallow next to snow's 0.35, but now more
  //                           than one texel of the near tier and more than a
  //                           quarter of a clipmap cell, so it is GEOMETRY.
  //   refill   20 -> 55       the rut still fills in under a minute; "springs
  //                           back" survives, "before you have turned round"
  //                           does not.
  //   maskLife 26 -> 95       the flattened, paler band a car leaves on grass
  //                           outlives the depression by a long way in life,
  //                           and it is the part the player actually sees.
  //   darken   0.44 -> 0.60   crushed grass is bruised, not merely dented.
  //   edge     0.42 -> 0.60   a wheel track through grass has a definite edge;
  //                           the old value put it below dune sand's.
  grass: {
    maxDepth: 0.12, refill: 55, maskLife: 95, collapse: 1.5,
    wet: 0.10, dry: 40, darken: 0.60, chroma: 0.88, expose: 0.42, edge: 0.60,
    drag: 1.3, grip: 1.02,
  },
  // "wet sand holds sharp dark tracks — see refs/mkw/beach-wet-sand-tracks.jpg,
  // the most literal reference we have." Dark, saturated, sharp-edged, and it
  // holds: collapse < 1 so the mark barely softens before the tide takes it.
  //
  // `darken` 0.72 -> 0.86 against a measurement of that reference. A critic
  // measured the perpendicular-scanline dip below local median at 61.8-82.0% in
  // the photograph and 19.9-31.6% in `tracks-fresh`: our tracks were roughly
  // half the contrast of the one image on the board that shows exactly this
  // surface doing exactly this thing. This is the knob that closes that, and it
  // is an ALBEDO knob, which is what the reference is — the tracks there are
  // the same sand, much darker, not a second material.
  wetSand: {
    maxDepth: 0.10, refill: 45, maskLife: 62, collapse: 0.7,
    wet: 0.95, dry: 110, darken: 0.86, chroma: 1.2, expose: 0.55, edge: 0.96,
    drag: 1.9, grip: 1.06,
  },
  // "ruts collapse fast (~8s), sand sprays at high slip." collapse 2.4: the
  // walls stand briefly and then slump all at once, which is what dry sand does.
  sand: {
    maxDepth: 0.12, refill: 8, maskLife: 11, collapse: 2.4,
    wet: 0.04, dry: 12, darken: 0.34, chroma: 0.92, expose: 0.34, edge: 0.30,
    drag: 2.6, grip: 0.92,
  },
  // Same collapse behaviour, hotter and paler. Desert is dry sand with the
  // colour response pulled almost to nothing — a rut in dune sand reads as
  // shape, not as tone.
  desert: {
    maxDepth: 0.13, refill: 8, maskLife: 10, collapse: 2.6,
    wet: 0.0, dry: 8, darken: 0.18, chroma: 0.9, expose: 0.22, edge: 0.24,
    drag: 2.8, grip: 0.9,
  },
  // "DEEPEST ruts, up to 0.35m. Refills over ~90s. Deep ruts expose dirt and
  // rock. Compacted snow is shinier than fresh." maskLife well past refill: the
  // compacted band stays visible after the trench has filled.
  snow: {
    maxDepth: 0.35, refill: 90, maskLife: 120, collapse: 0.65,
    wet: 0.22, dry: 190, darken: 0.34, chroma: 0.78, expose: 0.72, edge: 0.86,
    drag: 3.2, grip: 0.80,
  },
  // "leaf litter scatters, mud beneath, marks persist long. Highest contrast
  // between disturbed and pristine."
  forest: {
    maxDepth: 0.15, refill: 300, maskLife: 420, collapse: 1.0,
    wet: 0.55, dry: 240, darken: 0.66, chroma: 0.82, expose: 0.80, edge: 0.70,
    drag: 3.0, grip: 0.88,
  },
  // "longest persistence, essentially permanent until rain. Highest friction
  // penalty." 1200 s is below one unorm8 step per decay pass, so in practice
  // the mark does not move at all until the weather multiplier touches it —
  // which is exactly what "permanent until rain" means.
  mud: {
    maxDepth: 0.18, refill: 1200, maskLife: 1500, collapse: 1.0,
    wet: 0.90, dry: 900, darken: 0.62, chroma: 0.74, expose: 0.85, edge: 0.78,
    drag: 4.2, grip: 0.86,
  },
}

export type BiomeName = keyof typeof BIOMES

/** Case-insensitive lookup for `?biome=`. Throws rather than substituting. */
/**
 * ART_BIBLE §4 biome names -> the MATERIAL keys `BIOMES` is actually indexed by.
 *
 * These are two different vocabularies and only `forest` and `desert` happen to
 * collide. Without this map `?biome=alpine` — the exact URL documented in
 * CLAUDE.md and README.md — threw at boot, along with meadow, coast, lagoon and
 * wetland: five of the six biomes the art bible defines.
 */
const BIOME_ALIAS: Record<string, string> = {
  meadow: 'grass', grassland: 'grass', hub: 'grass',
  coast: 'wetSand', lagoon: 'wetSand', beach: 'wetSand', shore: 'wetSand',
  alpine: 'snow',
  wetland: 'mud', marsh: 'mud', swamp: 'mud',
  woodland: 'forest',
  dunes: 'desert',
}

export function biome(name: string): DeformResponse {
  const wanted = BIOME_ALIAS[name.toLowerCase()] ?? name
  const key = Object.keys(BIOMES).find((k) => k.toLowerCase() === wanted.toLowerCase())
  const r = key ? BIOMES[key] : undefined
  if (!r) {
    // A URL parameter must not be able to kill the boot. Warn and fall back to
    // the hub surface, so a typo degrades to "wrong ground" and not a blank page.
    console.warn(
      `[deform] no response for biome "${name}"; falling back to grass. ` +
      `known: ${[...Object.keys(BIOMES), ...Object.keys(BIOME_ALIAS)].join(', ')}`,
    )
    return BIOMES.grass as DeformResponse
  }
  return r
}

/** Linear blend of two responses. Every consumer lerps on the same weight. */
export function blend(a: DeformResponse, b: DeformResponse, t: number): DeformResponse {
  const m = (x: number, y: number): number => x + (y - x) * t
  return {
    maxDepth: m(a.maxDepth, b.maxDepth), refill: m(a.refill, b.refill),
    maskLife: m(a.maskLife, b.maskLife), collapse: m(a.collapse, b.collapse),
    wet: m(a.wet, b.wet), dry: m(a.dry, b.dry), darken: m(a.darken, b.darken),
    chroma: m(a.chroma, b.chroma), expose: m(a.expose, b.expose), edge: m(a.edge, b.edge),
    drag: m(a.drag, b.drag), grip: m(a.grip, b.grip),
  }
}

/**
 * Global decay multiplier from the weather.
 *
 * ART_BIBLE §9: "Rain — washes marks away. Snowfall — accumulation refills
 * ruts." M8 has not been built, so `weather` is still just a URL enum; the hook
 * exists here so that when the weather system lands it has one number to drive
 * and nothing downstream changes. ARCHITECTURE calls this out explicitly:
 * "Rain sets a global accelerated decay."
 */
export function weatherDecay(weather: string): number {
  switch (weather) {
    case 'rain': return 7      // washes marks away
    case 'storm': return 11
    case 'snow': return 3.5    // accumulation refills ruts
    case 'fog': return 1
    default: return 1
  }
}
