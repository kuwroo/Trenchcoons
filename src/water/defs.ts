// Water asset definitions — `assets/defs/water/*.json`.
//
// WHY A SECOND DEF TYPE RATHER THAN A SURFACE. CLAUDE.md's invariant is "no
// hardcoded assets: every asset is a JSON def in assets/defs/", and the water
// surface obeys it. It is NOT a `PainterlyParams` though, and folding thirty
// water-only keys into that interface would put `causticFlow` and `foamLace` on
// every rock, tree and grass blade in the build — `src/material/defs.ts` is
// strict on purpose ("a typo'd key would otherwise be silently dropped"), and
// the way that strictness stays useful is by each schema describing exactly one
// kind of thing. So: same file layout, same `{ id, version, type, material }`
// shape the Forge reads, same fold-onto-defaults loader, different schema.
//
// `assets/defs/surfaces/water.json` still exists and is still the painterly
// lagoon surface. Nothing in the world builds it any more, but it is enumerated
// by `surfaceIds()` and editable in the Forge, and ART_BIBLE keeps painterly
// water as a register.
//
// WHERE THE NUMBERS COME FROM. `refs/water/shore-foam-wake.jpg` sampled in
// twelve 140x18 px bands from open sea down to dry beach:
//
//   depth      colour     H    S     V
//   deepest    #2ea8c6   192  0.77  0.78
//   deep       #34b4cb   189  0.75  0.80
//   mid        #65c9c9   180  0.50  0.79
//   shallowing #99d8c8   165  0.29  0.85
//   shallow    #aedbc3   149  0.21  0.86
//   very sh.   #bbd9ba   119  0.14  0.85
//   sand under #c4d7b6    95  0.15  0.84
//   wet sand   #c7d4b1    82  0.16  0.83
//   beach      #c9c7a7    57  0.17  0.79
//   foam       #dbeedb   121  0.08  0.93  (a foam ring, so half water)
//
// The ladder is a 135-degree SIGNED hue rotation with saturation falling 0.77
// to 0.15, at a value that never drops below 0.73. `tools/water.mjs` gates
// exactly that, with a floor and a ceiling on each end, because a one-sided
// version of this metric is satisfied by painting the whole frame cyan.

/** Colours are authored as "#rrggbb"; everything else is a number. */
export interface WaterParams {
  // ── the depth ladder ──────────────────────────────────────────────────────
  /** Open-water stop. */
  deep: number
  /** Shelf stop. */
  mid: number
  /** Shallows stop. */
  shallow: number
  /**
   * The last stop before dry land, where the seabed reads through.
   *
   * DARKENED from #c4d7b6 to #aec39d, because the shallows were arriving at
   * V0.95 — brighter than foam itself. The reference's shallowest water band is
   * #bbd9ba at V0.85, and the half-stop of headroom that leaves is what lets a
   * white foam collar round a rock in the shallows read as white at all: at
   * V0.95 the collar and the water it sits in were within a few per cent of each
   * other and merged into one blob.
   */
  edge: number
  /** Foam and surf. Near-white, faintly green — never pure #ffffff. */
  foam: number
  /** Metres of depth at the mid stop. */
  depthMid: number
  /** Metres of depth at the shallow stop. */
  depthShallow: number
  /** Metres of depth at the edge stop. */
  depthEdge: number
  /**
   * Width of each ladder step as a fraction of the gap to the next one.
   *
   * 0 = four hard bands (the `lake-cartoon-cells.jpg` register), 1 = a smooth
   * gradient (the `shore-foam-wake.jpg` register). The references disagree and
   * both are right, so this is the knob between them.
   */
  bandSoftness: number
  /** How much of the baked ground colour reads through at the edge stop. */
  seabedMix: number
  /**
   * HORIZONTAL metres the ripple field displaces each ladder step's boundary.
   *
   * Without this the ladder is a contour map: three smooth curves following the
   * bathymetry exactly, which is a depth chart and not water. Warping the
   * boundary by the same field that draws the caustic is what makes the shallows
   * read as a rippling edge, and it is most of what the reference's shallow band
   * actually is.
   */
  bandWarp: number

  // ── the ripple / caustic network ──────────────────────────────────────────
  /**
   * The thin bright filigree, and the cell rims.
   *
   * #97e6eb — THE REFERENCE'S OWN MEASURED CREST, not foam white. It was
   * #f4fffc (S0.04), and mixing the albedo toward an almost-achromatic colour
   * has two consequences that both showed up in measurement:
   *
   *   The rim's residual hue comes from the LIGHT, not the sea. At the rim core
   *   the surface is a white albedo, so it takes whatever the light is —
   *   measured H155-162 at noon and H103 at dusk, against a plateau at H188.
   *   The reference's rim sits 4 degrees from its own plateau; ours sat 33 to
   *   109. It is also why the dusk sun path came out green: nothing in the
   *   material let water take the light's hue, only its level, so warm light on
   *   cyan went green.
   *
   *   And a near-white rim IS foam by any colour test. The gate's foam
   *   discriminator (S<0.10, V>0.85) was counting cell rims as surf, which
   *   thickened `shoreStroke` past its ceiling and merged the rock collars into
   *   the shore band so `solidRings` read 0.
   *
   * The reference's crest measures H183 S0.35 V0.92 against its plateau's H187
   * S0.54 — brighter and paler, still unmistakably water. Mixing toward S0.04
   * could not reach S0.35 at any strength.
   *
   * #d9f3e6: H154 (the reference crest's own hue, 32 degrees greener than the
   * plateau, which is half of what makes the cartoon read — a rim only 5 degrees
   * off the water reads as a highlight rather than a drawn border), but S0.11
   * rather than the crest's own S0.29.
   *
   * THE AUTHORED SATURATION IS PRE-COMPENSATED. The pipeline adds roughly 0.24 of
   * chroma between the def and the screen: authored S0.28 measured S0.52 on the
   * rim against the reference's rendered S0.29, and the result read as bright
   * green netting over teal — a lily-pad mat, not caustics. Matching the RENDERED
   * value is the only thing that matters and it means authoring well under it. It
   * has
   * to keep enough chroma to fail the gate's own foam test (S < 0.10) or the
   * cell rims are counted as surf — measured, at S0.04 they thickened
   * `shoreStroke` past its ceiling and merged the rock collars into the shore
   * band so `solidRings` read 0. And enough VALUE to read at all: at the
   * crest's exact V0.92 against our brighter deep stop the border collapsed to
   * `cellBorder` 0.001.
   */
  causticColour: number
  /** Metres across one big cell. `lake-cartoon-cells.jpg`'s polygons. */
  causticScale: number
  /** Metres across one fine ripple cell. `shore-foam-wake.jpg`'s texture. */
  causticFine: number
  /** 0 = flat water, 1 = a hard white net. */
  causticStrength: number
  /** Line width as a fraction of a cell. Small = graphic, large = mush. */
  causticWidth: number
  /** Cells per second of drift. Keep this slow; water is not a lava lamp. */
  causticFlow: number
  /** Share of the caustic that survives into open water. Shallow water gets
   *  all of it — that is where a real caustic focuses, and it is what the
   *  reference shows. */
  causticDeep: number

  // ── the cartoon cell field ────────────────────────────────────────────────
  //
  // `refs/water/lake-cartoon-cells.jpg` is FLAT MASSES meeting at crisp
  // borders, not thin lines on a smooth ground, and the ridge octaves above
  // cannot make that shape at any strength — measured, they reached cellSpread
  // 0.045 / cellEdge 3.4 against the reference's 0.156 / 11.0. These five
  // params are the mechanism that can. See the long note in water.ts.
  /**
   * Metres across one cell.
   *
   * 15 m, down from 55. At 55 the metric passed and the picture did not: the
   * `water-close` capture — three metres above the water, pitched down — showed
   * LESS THAN ONE CELL, so `cellSpread 0.081 / cellEdge 23.4` were being
   * satisfied by a single soft gradient across the whole frame. Scaled off the
   * reference instead of off the gate: `lake-cartoon-cells.jpg` fits roughly
   * eight cells across a pond that reads as about 60 m of water, so a cell is
   * of the order of 7-15 m, not 55.
   */
  cellScale: number
  /**
   * How many quantisation levels the cell noise is cut into.
   *
   * This sets how many DISTINCT flat masses the water carries, independently of
   * `cellScale`, which sets how big they are. Was `cellWarp` on a square
   * lattice; that mechanism rendered as a fishing net and is gone (see the note
   * in water.ts).
   */
  cellLevels: number
  /** Value swing between adjacent cells, as a fraction of the water's colour. */
  /**
   * How strongly each cell's own flat tone modulates the albedo.
   *
   * HELD LOW ON PURPOSE. A flat plate per cell is what makes the surface read as
   * OPAQUE POLYGONS rather than water — at 1.10 the `plateau` diagnostic reached
   * 0.575, i.e. most of the frame was flat facets with visible shading steps
   * between them, which is a mosaic and not a sea. The cell partition should
   * arrive as a RIM network laid over a continuous depth ramp, with the interior
   * tones only faintly separating neighbours.
   */
  cellAmp: number
  /**
   * Border width, compared against the Voronoi edge distance `F2 - F1`.
   *
   * RE-TUNED FOR THE PARTITION: 0.22 was fitted to the old contour field, where
   * it was a fraction of a quantisation LEVEL, and `F2 - F1` has a different
   * range entirely — at 0.22 the rims covered so much area that `cellBorder`
   * reached 0.506 against a 0.45 ceiling and the reference's 0.157.
   *
   * NARROW, and the narrowing is what reconciles two reference numbers that
   * looked contradictory. The lake reference's rims REACH white (brightest 6% at
   * V0.91) and yet its detrended cell amplitude is only 0.133; ours reached
   * white and measured 0.231. The difference is not brightness, it is AREA — at
   * 0.17 of a cell the border is a band, not a line, so it contributes its full
   * contrast over a third of the surface. It also aliases sooner than a wide one
   * would, which is why `rimAA`'s thresholds are expressed as fractions of this
   * value rather than as constants.
   */
  cellRim: number
  /**
   * How far the border goes toward `causticColour`.
   *
   * 0.95 and the colour is near-white, because the cartoon reference's rims
   * actually REACH white and ours did not: measured over open water, the
   * brightest 6% of the lake's cell box is #a5e7cb (V0.91, S0.29) and 0.19% of
   * it passes a foam test outright, against our #71d2ca (V0.82, S0.46) and
   * 0.00%. Rim-minus-body value contrast was 0.13 against the reference's 0.27.
   * At 0.65 toward a #dff8f4 the rim could not get there arithmetically.
   */
  cellRimStrength: number
  /**
   * The rim as a VALUE step in the water's own hue, which is what the reference
   * does. Measured on `refs/water/lake-cartoon-cells.jpg`, rim `#82dbe7`
   * H187 S0.44 V0.906 against its own cell interior `#53b1bd` H187 S0.56 V0.741:
   * value x1.22, saturation x0.79, hue IDENTICAL. Note that 1.22 is a ratio in
   * DISPLAY space and this multiplies LINEAR albedo, so the authored number is
   * about 1.22^2.2: at a literal 1.22 the on-screen step is only 9% and
   * `cellBorder` measured 0.000 — the rim was correct in hue and invisible.
   * Mixing toward
   * `causticColour` instead — a mint `#d9f3e6` — rotated our rim to H158-166
   * against H188 water, a 23-29 degree swing at 0.40 below the interior's
   * saturation, and that green netting laid over cyan was the whole
   * lily-pad read.
   */
  /**
   * 0 = the sharp Voronoi partition (hard polygons), 1 = fully bevelled cells.
   * See the channel note in src/water/voronoiTexture.ts: `F2 - F1` gives
   * "angular cobblestones" because bisectors are straight and meet at points,
   * and a soft minimum over the same bisectors rounds exactly those corners.
   */
  cellRound: number
  cellRimValue: number
  /** Fraction of the way the lifted rim goes toward its own luminance. */
  cellRimDesat: number
  /**
   * How much aerial perspective the water takes, 0..1.
   *
   * The one surface in the build that is allowed less than all of it. See the
   * note at the call site: at 1.0 the far water measured H213 S0.43, which is
   * sky, and neither reference has any water past H191.
   */
  aerial: number
  /**
   * Chroma removed from the SHALLOWS, 0..1, weighted by how shallow.
   *
   * The reference holds saturation flat at S0.15-0.18 across its whole mint
   * stretch; ours arrived at S0.37 there and S0.51 at dusk, which reads as a
   * lime swamp rather than water over sand. NOT fixable by authoring the stops
   * paler — `shallow` is already S0.11 and `mid` S0.22, and a blend of two
   * low-chroma colours cannot come out high-chroma — because what re-saturates
   * them is the per-channel filmic curve and the grade, downstream of this
   * material. So the correction is downstream too, and weighted by shallowness
   * so the deep end (which measures correctly) is untouched.
   */
  shallowDesat: number

  // ── the surface itself ────────────────────────────────────────────────────
  /** Peak wave height, metres. The references are nearly FLAT; this is small. */
  /**
   * Swell height, metres. RAISE `waveScale` WITH IT.
   *
   * Amplitude over wavelength is steepness, and steepness is what tilts the
   * shading normal. Taking `waveAmp` 0.32 -> 0.62 alone tilted it far enough to
   * catch much more sky: `deepVal` went 0.70 -> 0.82 against the reference's
   * 0.74, saturation fell, and the gate's foam test (low saturation, high value)
   * then scored 57% of the open sea as FOAM. The sea did not gain waves, it lost
   * its colour. Real swell grows in length as it grows in height, so scale both.
   */
  waveAmp: number
  /** Metres per primary wave. */
  waveScale: number
  /** Wave phase speed multiplier. */
  waveSpeed: number
  /** Horizontal Gerstner pinch, 0..1. */
  waveChop: number
  /**
   * THE BEACH SWASH. Metres the water level rises at the waterline as a wave
   * runs up the sand. It is a lift in the SURFACE, not a foam animation, so the
   * sheet genuinely floods the beach and drains off it and every shore term
   * that is authored in metres-from-the-waterline follows it for free. See
   * `swashLift` in src/water/waves.ts.
   */
  swashAmp: number
  /** Depth, in metres, by which the swash has faded to nothing. */
  swashReach: number
  /** Cycles per second. 0.075 is one wave every 13 s. */
  swashRate: number

  // ── foam ──────────────────────────────────────────────────────────────────
  /**
   * HORIZONTAL metres from the waterline the surf band covers.
   *
   * Was authored as metres of DEPTH and that produced a white belt a couple of
   * hundred metres wide on every coast in the game — see the long note in
   * water.ts. Depth is the wrong variable for anything measured along the
   * shore, because this world's shelves are nearly flat and a fixed depth
   * threshold therefore buys an unbounded distance.
   */
  foamShore: number
  /** How hard the noise breaks the shore band's inner edge into lace. */
  foamLace: number
  /** Metres per lace feature. */
  foamLaceScale: number
  /** How much a steep shelf narrows and brightens the band. */
  foamSlopeBias: number
  /** Multiplier on the wake field. */
  wakeStrength: number
  /** Lace on the wake, which is what turns a decaying smear into rings. */
  wakeLace: number
  /**
   * Metres per wake lace feature.
   *
   * 0.85 m, halved. The reference's wake carries 121 enclosed holes and ours had
   * 9 on a straight run, and the reason is that OUR holes were ring interiors
   * while the reference's are froth pinholes distributed through a mass — which
   * is also why its hull fill is only about half. Ring geometry cannot produce
   * them: on a straight chain consecutive interiors merge into channels however
   * the stride is set. The lace has to punch them, and at 1.7 m its holes were
   * larger than the rings they were meant to perforate.
   */
  wakeLaceScale: number

  // ── light ─────────────────────────────────────────────────────────────────
  /** Sun glint. ART_BIBLE §2 explicitly allows specular on water. */
  glintStrength: number
  /** Glint tightness. */
  glintPower: number
  /**
   * How far the glint's colour is pulled toward its own luminance before being
   * added. 0 adds the sun's colour raw; 1 adds a neutral of the same brightness.
   *
   * THIS EXISTS BECAUSE WARM PLUS CYAN PASSES THROUGH GREEN. At dusk the sun is
   * about H40 and the water about H185, and adding one to the other in RGB
   * raises red and green while leaving blue, so the sum lands near H140: the
   * dusk sun path measured H140-141 at S0.40 against deep water at H168-181,
   * a 28-40 degree rotation into green at high chroma, where
   * `refs/mkw/water-open-ocean.jpg`'s glitter sits at S0.00-0.11 and 0-18
   * degrees off its own water.
   *
   * A NEUTRAL added to cyan keeps the hue and drops the saturation, which is
   * what the reference's near-achromatic glitter actually is. Third instance of
   * this arithmetic in the water — see also the cell rim, which was mixing
   * toward a mint, and `causticColour`, which was white and therefore took the
   * light's hue. Anything bright that meets this cyan has to be neutral.
   */
  glintNeutral: number
  /** Sky reflected at grazing angles. Cartoon water is nearly opaque. */
  skyMix: number
  /** Chroma lost at full light, as everywhere else in the build. */
  saturationGain: number
  /** Scale on the sky-irradiance ambient. */
  ambient: number
}

export const WATER_DEFAULTS: WaterParams = {
  deep: 0x5eb4c7,
  mid: 0xa3d1d1,
  shallow: 0xc1dbce,
  edge: 0xaec39d,
  foam: 0xf4fdf6,
  depthMid: 15,
  depthShallow: 6,
  depthEdge: 1.1,
  bandSoftness: 0.30,
  seabedMix: 0.40,
  bandWarp: 2.6,
  causticColour: 0xd9f3e6,
  causticScale: 26,
  causticFine: 6.8,
  causticStrength: 0.10,
  causticWidth: 0.55,
  causticFlow: 0.055,
  causticDeep: 0.34,
  cellScale: 15,
  cellLevels: 2.8,
  cellAmp: 1.10,
  cellRim: 0.108,
  cellRimStrength: 0.80,
  cellRound: 0.72,
  cellRimValue: 2.60,
  cellRimDesat: 0.21,
  aerial: 0.5,
  shallowDesat: 0.55,
  waveAmp: 0.32,
  waveScale: 27,
  waveSpeed: 0.42,
  waveChop: 0.55,
  swashAmp: 0.90,
  swashReach: 2.6,
  swashRate: 0.075,
  foamShore: 11.5,
  foamLace: 2.80,
  foamLaceScale: 7.5,
  foamSlopeBias: 0.22,
  wakeStrength: 1,
  wakeLace: 1.3,
  wakeLaceScale: 0.85,
  glintStrength: 0.12,
  glintPower: 320,
  glintNeutral: 0.82,
  skyMix: 0.05,
  saturationGain: 0.31,
  ambient: 0.85,
}

const COLOUR_KEYS = ['deep', 'mid', 'shallow', 'edge', 'foam', 'causticColour'] as const
type ColourKey = (typeof COLOUR_KEYS)[number]
const isColourKey = (k: string): k is ColourKey =>
  (COLOUR_KEYS as readonly string[]).includes(k)

const NUMERIC_KEYS = Object.keys(WATER_DEFAULTS).filter((k) => !isColourKey(k))

interface WaterDef {
  id: string
  version: number
  type: string
  notes?: string
  material: Record<string, string | number>
}

function parseHex(id: string, key: string, v: string | number): number {
  if (typeof v === 'number') return v
  const m = /^#([0-9a-fA-F]{6})$/.exec(v)
  if (!m?.[1]) throw new Error(`${id}.material.${key}: expected "#rrggbb", got ${JSON.stringify(v)}`)
  return parseInt(m[1], 16)
}

/** Validate a def and fold it onto the defaults. Strict, like surfaces. */
export function waterParams(def: WaterDef): WaterParams {
  const out: WaterParams = { ...WATER_DEFAULTS }
  for (const [key, value] of Object.entries(def.material)) {
    if (isColourKey(key)) {
      out[key] = parseHex(def.id, key, value)
    } else if (NUMERIC_KEYS.includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${def.id}.material.${key}: expected a number, got ${JSON.stringify(value)}`)
      }
      ;(out as unknown as Record<string, number>)[key] = value
    } else {
      throw new Error(`${def.id}.material.${key}: not a WaterParams key`)
    }
  }
  return out
}

// Bundled at build time — no async load to race `__ready` against.
const modules = import.meta.glob<{ default: WaterDef }>(
  '/assets/defs/water/*.json', { eager: true },
)

const REGISTRY = new Map<string, WaterParams>()
for (const mod of Object.values(modules)) {
  const def = mod.default
  if (def.type !== 'water') continue
  if (REGISTRY.has(def.id)) throw new Error(`duplicate water def id: ${def.id}`)
  REGISTRY.set(def.id, waterParams(def))
}

export function waterIds(): string[] {
  return [...REGISTRY.keys()].sort()
}

/** Look up a water def. Throws rather than silently substituting. */
export function water(id: string): WaterParams {
  const p = REGISTRY.get(id)
  if (!p) throw new Error(`no water def "${id}" (have: ${waterIds().join(', ')})`)
  return p
}
