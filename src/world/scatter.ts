// Biome scatter: rock, tree, shrub and deadwood placement.
//
// Consumes the modeller's library — `ScatterLibrary` for geometry and material,
// `asset.collider` for the collision proxy, `asset.bounds` for the footprint.
// Nothing here generates a mesh.
//
// WHAT DECIDES WHAT GOES WHERE. Every biome in src/terrain/biomes.ts declares a
// scatter set with a density in instances per square kilometre. A cell's
// probability of carrying a form is the sum over ALL biomes of (that biome's
// weight here) x (that entry's density), and the entry is then chosen in
// proportion to the same products. That is the "scatter sets overlap wherever
// weights overlap" clause of ART_BIBLE §5 falling out of the arithmetic rather
// than being special-cased: a few pines survive into the meadow's edge because
// the forest's weight there is 0.2, not because anything says so.
//
// FIVE BANDS. A form's LOD rung is a property of the band it was placed in, so
// there is no per-instance LOD test anywhere in the frame, and only one band is
// rebuilt per call. Bands are NOT density steps — whether a cell is drawn at all
// is a continuous function of its distance and the form's own size, see
// `cellRank` and `THIN_MIN`/`THIN_MAX`.
//
// THE BURIAL LIFT. Every instance is raised by its own LOD0 bounding-box floor
// before being sunk by a fixed embed fraction. The rock generator centres its
// block on y=0 and never lifts it by the half-height, so a rock-medium placed
// naively sits 66% underground and a rock-slab variant sits entirely below the
// surface. That is an asset-side bug and src/assets is not ours to edit, but a
// placement that reads the geometry it is placing cannot be fooled by it — and
// the same lift is applied to the collision proxy, so physics and pixels agree.

import * as THREE from 'three/webgpu'
import { float, positionWorld, texture, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { spatialHash } from '../core/spatialHash'
import { PainterlyMaterial } from '../material/painterly'
import { ScatterLibrary } from '../assets'
import type { TerrainWorld } from '../terrain/world'
import { BIOME_COUNT, BIOME_IDS, BIOME_STYLES } from '../terrain/biomes'
import { buildProxy, type ProxyPoly } from './proxy'
import { biomeTint, graded } from './surfaceGrade'
import { ROAD_HALF } from './pathCurve'

/**
 * Distance thinning. A form is drawn out to `d0` at full authored density and
 * then thinned as `(d0 / d)^2`, which holds its count per unit of SCREEN area
 * roughly constant rather than its count per unit of ground.
 *
 * `d0` is per def and scales with the form's own height, because the whole point
 * is to thin where a form is small on screen. A 0.4 m pebble and a 14 m conifer
 * at 150 m are a pixel and a hundred pixels; thinning them at the same range
 * either wastes the pebbles or guts the forest.
 *
 * THE FLOOR IS BAND 0's RADIUS, deliberately. Nothing is thinned inside 55 m, so
 * the near-field density every structure/palette gate is calibrated against is
 * untouched by this ladder — `grass-close` is already short of its FORMLESS
 * floor and this is not the place to spend that margin.
 *
 * THE CEILING IS PINNED TO `BANDS`, and raising it is very nearly FREE, which
 * is the opposite of what it looks like. It roughly doubles the number of
 * instances a tall form places — and every one of them lands in the mid field
 * at LOD1 or LOD2, because band 0 draws everything within 55 m either way and
 * `THIN_MIN` guarantees nothing is thinned inside it. It also makes the lattice
 * CHEAPER: pushing the radii out to 200/400/800 moves cells from the two
 * fine-stride bands into the coarse ones, 39,553 cells a full rotation down to
 * 30,623. A first pass cut it to 70 to protect the frame budget and had the
 * trade backwards.
 */
const THIN_MIN = 55
const THIN_MAX = 100
const THIN_MAX2 = THIN_MAX * THIN_MAX
/**
 * Metres of `d0` per metre of form height.
 *
 * 10 rather than 6, and 6 was measured as too small: `qn-pine-1` is 10.5 m, so
 * at 6 it got `d0` 63 m and a cut distance of about 62 m — and a tree appearing
 * at 50 m is 30 PIXELS of form even at 0.18 of its scale, because a 10.5 m form
 * at 50 m is 170 px when whole. The gate found it; the single-site probe that
 * signed off the 70/6 pair did not, because that site had no pines near a
 * boundary. At 10 anything 10 m or taller sits at the `THIN_MAX` ceiling and is
 * full-density to 100 m, where the same first step is 1.6 px.
 */
const THIN_PER_M = 10
/**
 * The thinning exponent: density falls as `(d0 / d)^1.5`.
 *
 * NOT 2, and the difference is the whole far field. 2 is the screen-area
 * preserving figure and it was tried first: it holds the near field beautifully
 * and GUTS everything past 100 m, because the step ladder it replaced was much
 * flatter than an inverse square. Measured at the meadow site, instances drawn
 * in total: 507 on the old ladder, 193 at exponent 2, and nothing at all past
 * 880 m.
 *
 * 1.5 was solved rather than dialled. Integrating the old step ladder against
 * this curve over 0-1300 m, for a form at the 55 m floor:
 *
 *     old steps  1 / 0.25 / 0.0625 / 0.0156      167,419 m^2 of effective area
 *     exponent 2                                  69,638   42%
 *     exponent 1.5                               156,353   93%
 *
 * So 1.5 keeps the content budget the build was perf-tuned around and spends the
 * change on making it continuous. It also means screen density RISES with
 * distance, which is what a treeline should do.
 */
const THIN_P = 1.5
/**
 * Band outer radii, metres. Bands are LOD rungs and rebuild units; they are NOT
 * density steps — see `cellRank` for what decides whether a cell is drawn.
 *
 * 55 for the LOD0 ring, and it is the cheapest 5 ms in the build. The scatter
 * library's conifer LOD0 is 712 triangles, band 0 is the only band that casts
 * into the sun cascades, and the forest authors 8000 conifers per square
 * kilometre — so at an 80 m radius the near ring alone was carrying ~1100
 * conifer instances at 712 triangles, drawn once for the frame and again per
 * cascade.
 *
 * THE OUTER RADII ARE NOT FREE CHOICES. Each is the distance at which the
 * thinning function `(THIN_MAX / d)^THIN_P` falls to the next stride's lattice
 * density, so a form's desired density is always reachable by the band it lands
 * in and never has to be clipped to the band's ceiling. That is
 * `THIN_MAX * 4^(k / THIN_P)`, i.e. `70 * 2^(4k/3)`: 176.4, 444.5, 1120. Change
 * one and you must change the others, and the constructor throws if they drift
 * apart — a silent drift puts the 4x pop straight back.
 *
 * The last band draws the library's IMPOSTOR rather than a mesh rung. Band 2
 * used to run to 900 m and hand ~2000 conifers their LOD2 at 208 triangles each
 * — 416k triangles of three-to-six-pixel trees, in a frame measured at 1150k
 * total. The impostor exists precisely for that job (the modeller's
 * `tieredCards` traces the real sawtooth profile with up-facing normals so its
 * value matches LOD0's rather than popping), and using it past 445 m costs
 * single-digit triangles per instance. Two bands share it, because they need
 * different strides and not different geometry.
 */
const SCATTER_REACH = 1300
const BANDS = [
  55,
  THIN_MAX * 2 ** (4 / 3),
  THIN_MAX * 2 ** (8 / 3),
  THIN_MAX * 16,
  SCATTER_REACH,
] as const
/**
 * Placement lattice — ONE hierarchy, not five independent grids, and the
 * hierarchy is what makes distance thinning free of churn.
 *
 * The old `BAND_CELL = [3.4, 13, 26, 58]` sampled each annulus on its own
 * jittered lattice, so crossing a band radius swapped which WORLD POINTS were
 * allowed to carry a form. That was fixed by having far bands visit every Nth
 * FINE cell — but the fix left a worse fault in its place, and it is the one
 * this ladder exists to remove: a band that visits every 2nd cell can carry AT
 * MOST a quarter of the authored density, so density fell 4x at a hard radius.
 * MEASURED, at the meadow site, instances per hectare:
 *
 *     45- 55 m  31.83      200-230 m  9.87      460-560 m  1.56
 *     55- 65 m   7.96      230-260 m  2.17      560-620 m  0.63
 *
 * Three-quarters of everything between 55 m and 230 m did not exist and
 * materialised the instant the player crossed 55 m. That is the "trees and rocks
 * spawn in front of my eyes" report, and no amount of care in the lattice's
 * PHASE could have touched it: it is the stride's CEILING, not its alignment.
 *
 * Strides still exist, because iterating a 3.4 m lattice out to 1300 m is
 * 460,000 cells a rebuild. They are now only an ITERATION device, and the band
 * radii above are chosen so that the density a form actually wants at a band's
 * inner edge is exactly that band's stride ceiling. Density is therefore
 * continuous across every boundary.
 */
const BASE_CELL = 3.4
/** Fine-cell step per band. Powers of two, so far cells are a subset of near. */
const BAND_STRIDE = [1, 1, 2, 4, 8] as const
/**
 * Which mesh rung each band draws. -1 is the impostor.
 *
 * Bands 0 and 1 share the fine lattice and differ only in rung and in shadow
 * casting: full density has to reach much further than LOD0 can afford, so the
 * near ring is SPLIT rather than widened.
 */
const BAND_LOD = [0, 1, 2, -1, -1] as const
/**
 * The most of the authored density a band can express: `1 / stride^2`.
 *
 * A cell is drawn when its rank is under the threshold, and `cellRank` is built
 * so that a threshold of exactly `4^-k` selects exactly the stride-`2^k`
 * lattice. So this is both the ceiling and the rank at which the next band takes
 * over, and the two cannot disagree.
 */
const BAND_KEEP_CEIL = BAND_STRIDE.map((s) => 1 / (s * s))
/**
 * How much of the way in from its cut distance a form takes to reach full size.
 *
 * A rank cut is still a binary event, so without this a form appears at its own
 * cut distance at full size — better than the old synchronised wall at 55 m, but
 * still a pop. The fade spans keep `q` to `q / (1 - FADE)`, which at exponent
 * 1.5 is `d_cut` down to `d_cut * (1 - FADE) ** (2/3)`: at 0.55 a form whose cut
 * distance is 150 m grows in over 150-88 m and is full size for every metre of
 * the approach after that.
 *
 * It costs one multiply on the instance scale and no shader work.
 */
const THIN_FADE = 0.55
/** Fraction of `SCATTER_REACH` over which the outermost band fades to nothing. */
const REACH_FADE = 0.08
/**
 * Instance ceiling per (def, variant, band).
 *
 * A FRAME BUDGET, not a memory one, and sized so it does not normally bite: a
 * cap that bites is its own pop-in, since the fringe of a capped batch streams
 * as the camera moves. The figures are the dense forest's 8000 conifers per
 * square kilometre integrated over each annulus under the thinning above, plus
 * headroom for a cell where two dense biomes overlap.
 */
const BAND_CAP = [340, 900, 700, 700, 500] as const
/**
 * Metres the streaming centre may drift before a band is rebuilt.
 *
 * Not one number, because the two things a rebuild buys are worth different
 * amounts per band. A near band's rebuild advances the grow-in fade and moves
 * the collision set under the kart; an outer band's moves a horizon nobody is
 * looking at, and costs 8,000 lattice cells to do it. Solved against the fade
 * rather than chosen: the grow-in window is proportional to a form's cut
 * distance, so the tolerance has to be a small fraction of the band's inner
 * radius for the fade to arrive in steps too small to see.
 */
const BAND_TOLERANCE = [3, 6, 15, 40, 80] as const
/** Fraction of its own height an instance is sunk into the ground. */
const EMBED = 0.06

/**
 * A cell's place in the thinning order, in [4^-4, 1).
 *
 * THIS IS THE WHOLE TRICK, so it is worth stating plainly. A cell is drawn when
 * `rank < threshold`. If rank were a flat hash, a threshold of 0.25 would pick a
 * random quarter of cells — and a stride-2 band can only VISIT the even cells,
 * so the set the threshold asks for and the set the band can offer would be
 * different sets, and crossing the boundary would swap 75% of the instances in
 * the ring. Continuous density, churning identity: the same flicker the old
 * per-band lattices produced, arrived at from the other direction.
 *
 * So rank is HIERARCHICAL. `level` is how many low bits are zero in both cell
 * indices — level k cells are exactly the stride-2^k lattice — and each level
 * gets its own disjoint slice of [0, 1), coarser lattices ranking lower:
 *
 *     level 0   75%    of cells   rank [0.25,     1)
 *     level 1   18.75%            rank [0.0625,   0.25)
 *     level 2   4.6875%           rank [0.015625, 0.0625)
 *     level 3+  1.5625%           rank [0.00390625, 0.015625)
 *
 * A threshold of exactly `4^-k` therefore selects exactly the stride-2^k
 * lattice, which is exactly what a stride-2^k band visits. The threshold and the
 * band agree by construction, at every value and not just at the boundaries, so
 * a form's identity never depends on which band is drawing it. Within a level
 * the order is a hash, so which forms survive is spatially random rather than
 * patterned.
 *
 * Levels are capped at 3 because 8 is the coarsest stride.
 */
const RANK_BASE = [0.25, 0.0625, 0.015625, 0.00390625] as const

/**
 * `(d0 / d)^THIN_P`, taking `(d0 / d)^2` — which is free, distances are already
 * squared — as its argument.
 *
 * `a ** 0.75` is `a / a ** 0.25`, and two `Math.sqrt` calls are several times
 * cheaper than one `Math.pow`. This runs on every lattice cell in every band,
 * about 40,000 a full rotation, so that matters.
 */
function thinKeep(a2: number): number {
  return a2 / Math.sqrt(Math.sqrt(a2))
}

/** Full-density radius for a def, from the tallest variant it can place. */
function thinRadius(heights: number[]): number {
  let h = 0
  for (const v of heights) if (v > h) h = v
  return Math.min(THIN_MAX, Math.max(THIN_MIN, h * THIN_PER_M))
}

function cellRank(i: number, j: number, u: number): number {
  // i and j are both divisible by 2^k exactly when (i | j) is, so one
  // trailing-zero count answers for the pair. (i | j) & 7 === 0 also covers
  // i = j = 0, whose level is unbounded and clamps to 3.
  const m = (i | j) & 7
  const level = (m & 1) !== 0 ? 0 : (m & 2) !== 0 ? 1 : (m & 4) !== 0 ? 2 : 3
  const base = RANK_BASE[level]!
  // base .. 4 * base, i.e. this level's own slice and no other's.
  return base * (1 + 3 * u)
}

/**
 * Canopy trees. Their placement rate is multiplied by `groveAt` (clumps with
 * clearings) so the stand reads as organised rather than a uniform lattice.
 *
 * Meadow/forest canopy is Quaternius (`qn-*`) from the overgrown-portfolio
 * nature guide; alpine still uses procedural conifers. Legacy `pp-*` ids stay
 * listed so any leftover biome entry still clumps correctly.
 */
const TREE_IDS = new Set([
  'conifer-tall', 'conifer-young',
  'pp-tree-broad', 'pp-tree-round',
  'pp-birch-tall', 'pp-birch-young',
  'qn-common-1', 'qn-common-2', 'qn-common-3', 'qn-common-4', 'qn-common-5',
  'qn-pine-1', 'qn-pine-2', 'qn-pine-3',
  'qn-twisted-1', 'qn-twisted-2',
])

/**
 * Soft understory that should live WITH stands, not as open-field scrub.
 * Overgrown places bushes as rings around trees; we approximate that by
 * multiplying rate by `groveAt` (softer than trees' grove²).
 */
const UNDERSTORY_IDS = new Set([
  'qn-bush', 'qn-clover-1', 'qn-clover-2', 'qn-mushroom',
])

/**
 * Which of the terrain's baked palette maps a surface takes its biome tint from,
 * and how strongly.
 *
 * `rock` is the biome's own stone colour — a field of its own rather than the
 * ground's `cliff`, because a forest hillside breaks to SOIL and a boulder
 * standing in that forest is still stone (see `BiomeStyle.rock`): ART_BIBLE §4's exposed rock #3A3F42 in the alpine, #B87A4F in
 * the desert, a lifted blue-grey in the meadow. Anything made of stone follows
 * it. `lit` is the ground's own lit stop, which is what vegetation should follow
 * — a bush at the desert's edge is a drier, paler bush.
 *
 * Rock is tinted almost fully (0.95) and vegetation softly (0.45-0.5). The measured failure
 * was entirely on the rock side: every scatter rock in the game rendered the
 * same blue-grey everywhere, and in the alpine that meant slab faces at
 * #94BFDD, luma 0.867 — LIGHTER than the snow shadow, so the dark ridges
 * ART_BIBLE says carry that biome's whole compositional load could not punch
 * through. 0.95 rather than 0.85 because at 0.85 an alpine slab still measured
 * luma 0.515 against snow at 0.79-0.89, and "high contrast against snow" is not
 * 0.6x; at 0.95 it lands near 0.35, which is 0.4x and reads as the dark rock the
 * biome is navigated by. Vegetation stays mostly its own colour because a conifer is a
 * conifer; it is the ground under it that changes.
 *
 * `bark` is deliberately absent. A trunk is warm red-brown per ART_BIBLE §4 in
 * every biome that has trees, and multiplying it by the alpine's snow map would
 * bleach it.
 */
const TINT_SOURCE: Record<string, { map: 'rock' | 'lit'; strength: number }> = {
  stone: { map: 'rock', strength: 0.95 },
  massif: { map: 'rock', strength: 0.95 },
  rock: { map: 'rock', strength: 0.95 },
  mountain: { map: 'rock', strength: 0.95 },
  cliff: { map: 'rock', strength: 0.95 },
  needle: { map: 'lit', strength: 0.45 },
  leaf: { map: 'lit', strength: 0.5 },
  foliage: { map: 'lit', strength: 0.45 },
  foliageAutumn: { map: 'lit', strength: 0.4 },
  bush: { map: 'lit', strength: 0.5 },
  scrub: { map: 'lit', strength: 0.7 },
  grassMound: { map: 'lit', strength: 0.7 },
}

/**
 * The meadow's own values for the two maps above — the biome every surface in
 * the library was graded in, and therefore the colour at which `biomeTint`
 * returns 1. Kept next to the table it belongs to rather than imported, because
 * the pairing is "what this tint is measured AGAINST", not "what the meadow is".
 */
const TINT_REFERENCE = { rock: 0x7d95a4, lit: 0x85ce4c } as const

export interface Obstacle {
  x: number
  z: number
  /** Horizontal radius, metres. */
  r: number
}

/** A solid instance, as the collision solver wants it. */
export interface SolidInstance {
  x: number
  y: number
  z: number
  /** cos/sin of the instance yaw, so the solver never calls a trig function. */
  cos: number
  sin: number
  scale: number
  poly: ProxyPoly
  /** World Y of the top of the proxy. */
  topY: number
  /** Broad-phase radius in world units. */
  radius: number
}

/** One (def, variant, band) draw. */
interface Batch {
  meshes: THREE.InstancedMesh[]
  cap: number
  count: number
}

/**
 * A lattice cell that wants to place, deferred until the band's cap can pick
 * nearest-first. Visit-order fill made the surviving set a function of the
 * camera — drive five metres and a different rock won the last slot. Ranking
 * by distance keeps underfoot content fixed; only the horizon fringe streams.
 */
/** One row of `Scatter.dumpSink`. Diagnostic only; see `tools/popin.mjs`. */
export interface DumpRow {
  x: number
  z: number
  band: number
  key: string
  /** Instance scale, with the distance fade already folded in. */
  scale: number
  fade: number
  /** Drawn height in metres, i.e. the variant's authored height times `scale`. */
  h: number
}

interface Cand {
  key: string
  d2: number
  /** The thinning fade already folded into `scale`. Diagnostic only. */
  fade: number
  /** The variant's authored height, for the gate's pixel arithmetic. */
  height: number
  x: number
  y: number
  z: number
  scale: number
  yaw: number
  lift: number
  footprint: number
  proxy: ProxyPoly | null
}

interface Choice {
  biome: number
  id: string
  perM2: number
  scaleLo: number
  scaleHi: number
  maxSlope: number
  /** Metres of water this form may stand in. See `ScatterEntry.wade`. */
  wade: number
}

interface DefInfo {
  id: string
  variants: number
  /** Per variant: the y-lift that puts the LOD0 floor on the ground. */
  lift: number[]
  height: number[]
  footprint: number[]
  proxy: (ProxyPoly | null)[]
  /**
   * Full-density radius, metres. Beyond it the def thins as `(d0 / d)^2`.
   *
   * Per DEF and not per variant, so a def's cut distance cannot depend on which
   * variant a cell rolled — the rank test has to be a pure function of the cell
   * or a form changes its mind about existing as the camera moves.
   */
  d0: number
}

export class Scatter {
  /** Everything, for adding to the scene. */
  readonly group = new THREE.Group()
  /** Band 0 only. The rest is hidden from the shadow cascades by main.ts. */
  readonly nearGroup = new THREE.Group()
  readonly farGroup = new THREE.Group()
  /** Near solid forms, for spawn validation and the chase camera. Mutated in
   *  place so holders of the reference always see the current set. */
  readonly obstacles: Obstacle[] = []
  /** Near solid forms, for the kart. Same lifetime as `obstacles`. */
  readonly solids: SolidInstance[] = []
  readonly materials: PainterlyMaterial[] = []

  /**
   * Diagnostic. When non-null, every DRAWN instance is appended here as it is
   * written into its batch, so `__trench.scatterAt` can diff the placed set at
   * two camera positions and measure pop-in directly instead of by eye.
   *
   * Null in play. The array is not cleared per band — the caller sets it, forces
   * a full four-band rebuild, and takes the result.
   */
  dumpSink: DumpRow[] | null = null

  private readonly byParams = new Map<string, PainterlyMaterial>()
  private readonly defs = new Map<string, DefInfo>()
  private readonly choices: Choice[] = []
  private readonly batches = new Map<string, Batch>()
  private readonly weights = new Float32Array(BIOME_COUNT)
  private readonly acc = new Float64Array(64)
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private readonly p = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  /** Reused every rebuild so the candidate pass never allocates. */
  private readonly cands: Cand[] = []
  private readonly candPool: Cand[] = []
  /** Streaming centre each band was last built at. NaN until the first build. */
  private readonly builtX = new Float64Array(BANDS.length).fill(Number.NaN)
  private readonly builtZ = new Float64Array(BANDS.length).fill(Number.NaN)
  private forceNext = true
  /**
   * An exact upper bound on a cell's placement probability, over every biome.
   *
   * Weights are normalised and every other factor (`groveAt`, the path taper)
   * is <= 1, so no cell's `total` can exceed the densest single biome's summed
   * density. That makes it a free prefilter on the same hash channel the exact
   * roll uses.
   */
  private rollMax = 1
  private readonly worldSeed: number

  constructor(
    atmosphere: Atmosphere,
    private readonly world: TerrainWorld,
    private readonly library: ScatterLibrary,
  ) {
    this.worldSeed = world.seed
    this.group.name = 'scatter'
    this.nearGroup.name = 'scatter-near'
    this.farGroup.name = 'scatter-far'
    this.group.add(this.nearGroup, this.farGroup)

    const ids = new Set<string>()
    for (let b = 0; b < BIOME_COUNT; b++) {
      for (const entry of BIOME_STYLES[BIOME_IDS[b]!].scatter) {
        ids.add(entry.id)
        this.choices.push({
          biome: b,
          id: entry.id,
          perM2: entry.perKm2 * 1e-6,
          scaleLo: entry.scale[0],
          scaleHi: entry.scale[1],
          maxSlope: entry.maxSlope ?? 0.7,
          wade: entry.wade ?? 0,
        })
      }
    }

    if (this.choices.length > this.acc.length) {
      throw new Error(`scatter: ${this.choices.length} entries exceeds the acc buffer`)
    }
    this.recomputeRollMax()
    // `thinKeep` hardcodes the exponent as a pair of square roots for speed, so
    // it and `THIN_P` can silently disagree. They are checked against each
    // other rather than trusted, on this file's own standing rule that a
    // constant derived from another constant has to be written as a function of
    // it or asserted against it.
    for (const probe of [0.01, 0.25, 1, 4]) {
      if (Math.abs(thinKeep(probe) - probe ** (THIN_P / 2)) > 1e-9) {
        throw new Error(`scatter: thinKeep does not implement exponent ${THIN_P}`)
      }
    }
    // The band radii and the thinning ceiling are one design, not two knobs —
    // see `BANDS`. If they drift apart the largest forms want more density at a
    // boundary than the band can carry and the 4x pop comes back silently.
    for (let band = 1; band < BANDS.length; band++) {
      const want = thinKeep(THIN_MAX2 / (BANDS[band - 1]! * BANDS[band - 1]!))
      if (Math.abs(Math.min(want, 1) - BAND_KEEP_CEIL[band]!) > 1e-9) {
        throw new Error(
          `scatter: band ${band} inner radius ${BANDS[band - 1]} wants keep ` +
          `${Math.min(want, 1).toFixed(5)} but its stride ${BAND_STRIDE[band]} ` +
          `ceils at ${BAND_KEEP_CEIL[band]!.toFixed(5)}`,
        )
      }
    }
    const box = new THREE.Box3()
    for (const id of ids) {
      const variants = library.variants(id)
      const info: DefInfo = { id, variants, lift: [], height: [], footprint: [], proxy: [], d0: THIN_MIN }
      for (let v = 0; v < variants; v++) {
        const asset = library.asset(id, v)
        // The floor of the DRAWN mesh, not of `bounds`: `bounds.height` is an
        // extent and says nothing about where the origin sits inside it.
        let floor = 0
        for (const part of asset.parts) {
          const geo = part.lods[0]!.geometry
          if (!geo.boundingBox) geo.computeBoundingBox()
          box.copy(geo.boundingBox!)
          if (box.min.y < floor) floor = box.min.y
        }
        info.lift.push(-floor)
        info.height.push(asset.bounds.height)
        info.footprint.push(asset.bounds.footprint)
        info.proxy.push(buildProxy(asset.collider))
      }
      info.d0 = thinRadius(info.height)
      this.defs.set(id, info)

      for (let v = 0; v < variants; v++) {
        const asset = library.asset(id, v)
        for (let band = 0; band < BANDS.length; band++) {
          const cap = BAND_CAP[band]!
          const meshes: THREE.InstancedMesh[] = []
          for (const part of asset.parts) {
            // The last band draws the impostor. `impostorShared` means the
            // library has declared its coarsest mesh rung to BE the impostor —
            // legitimate for a compact convex solid like a rock — in which case
            // there is nothing separate to reach for.
            const rung = BAND_LOD[band]!
            const lod = rung < 0
              ? (part.impostorShared ? part.lods[part.lods.length - 1]! : part.impostor)
              : part.lods[Math.min(rung, part.lods.length - 1)]!
            const mesh = new THREE.InstancedMesh(lod.geometry, this.material(atmosphere, part.surface, part.material), cap)
            mesh.name = `scatter-${id}-v${v}-b${band}-${part.slot}`
            mesh.count = 0
            mesh.frustumCulled = false
            ;(band === 0 ? this.nearGroup : this.farGroup).add(mesh)
            meshes.push(mesh)
          }
          this.batches.set(`${id}#${v}#${band}`, { meshes, cap, count: 0 })
        }
      }
    }
  }

  /**
   * One material per resolved param set, with the abandoned painterly overlay
   * switched OFF.
   *
   * See `src/world/surfaceGrade.ts` for what `graded` changes and why it is an
   * override at the point of use rather than a def edit.
   */
  private material(
    atmosphere: Atmosphere, surfaceId: string, params: PainterlyMaterial['params'],
  ): THREE.Material {
    const clean = graded(surfaceId, params)
    // Keyed on the SURFACE as well as the params, because two surfaces can grade
    // to the same numbers and take their tint from different maps.
    const key = `${surfaceId}|${JSON.stringify(clean)}`
    const hit = this.byParams.get(key)
    if (hit) return hit.material
    // ── the biome tint ───────────────────────────────────────────────────────
    // Read from the instance's own world position via the terrain's baked map,
    // so it costs one texture fetch and cannot drift from the classification the
    // placement, the ground and the deform response all share. `positionWorld`
    // is per-fragment and the map is 16 m per texel, so an instance is uniformly
    // tinted in practice without needing an attribute.
    const src = TINT_SOURCE[surfaceId]
    let tint: ReturnType<typeof biomeTint> | undefined
    if (src) {
      const map = src.map === 'rock' ? this.world.rockMap : this.world.litMap
      tint = biomeTint(
        texture(map, this.mapUv()).rgb, TINT_REFERENCE[src.map], src.strength,
      )
    }
    const pm = new PainterlyMaterial(atmosphere, clean, null, tint ? { tint } : {})
    this.byParams.set(key, pm)
    this.materials.push(pm)
    return pm.material
  }

  /** World XZ of the fragment -> the terrain's baked-map UV. */
  private mapUv(): Node<'vec2'> {
    const wp = vec3(positionWorld)
    return vec2(vec2(wp.x, wp.z).div(float(this.world.span)).add(0.5))
  }

  /**
   * Rebuild the placement choice table from the live `BIOME_STYLES`.
   * Forge Environments mutates densities / scatter sets and then calls this
   * before a forced `update(..., true)`. New asset ids are registered on
   * demand so an editor can add library entries that were not in the table
   * at construction time.
   */
  reloadChoices(atmosphere: Atmosphere): void {
    this.choices.length = 0
    const needed = new Set<string>()
    for (let b = 0; b < BIOME_COUNT; b++) {
      for (const entry of BIOME_STYLES[BIOME_IDS[b]!].scatter) {
        needed.add(entry.id)
        this.choices.push({
          biome: b,
          id: entry.id,
          perM2: entry.perKm2 * 1e-6,
          scaleLo: entry.scale[0],
          scaleHi: entry.scale[1],
          maxSlope: entry.maxSlope ?? 0.7,
          wade: entry.wade ?? 0,
        })
      }
    }
    if (this.choices.length > this.acc.length) {
      throw new Error(`scatter: ${this.choices.length} entries exceeds the acc buffer`)
    }
    this.recomputeRollMax()
    for (const id of needed) {
      if (!this.defs.has(id)) this.registerDef(atmosphere, id)
    }
    this.forceNext = true
  }

  /** Ensure batches exist for a scatter def that was not in the table at boot. */
  private registerDef(atmosphere: Atmosphere, id: string): void {
    const variants = this.library.variants(id)
    const box = new THREE.Box3()
    const info: DefInfo = { id, variants, lift: [], height: [], footprint: [], proxy: [], d0: THIN_MIN }
    for (let v = 0; v < variants; v++) {
      const asset = this.library.asset(id, v)
      let floor = 0
      for (const part of asset.parts) {
        const geo = part.lods[0]!.geometry
        if (!geo.boundingBox) geo.computeBoundingBox()
        box.copy(geo.boundingBox!)
        if (box.min.y < floor) floor = box.min.y
      }
      info.lift.push(-floor)
      info.height.push(asset.bounds.height)
      info.footprint.push(asset.bounds.footprint)
      info.proxy.push(buildProxy(asset.collider))
    }
    info.d0 = thinRadius(info.height)
    this.defs.set(id, info)

    for (let v = 0; v < variants; v++) {
      const asset = this.library.asset(id, v)
      for (let band = 0; band < BANDS.length; band++) {
        const key = `${id}#${v}#${band}`
        if (this.batches.has(key)) continue
        const cap = BAND_CAP[band]!
        const meshes: THREE.InstancedMesh[] = []
        for (const part of asset.parts) {
          const rung = BAND_LOD[band]!
          const lod = rung < 0
            ? (part.impostorShared ? part.lods[part.lods.length - 1]! : part.impostor)
            : part.lods[Math.min(rung, part.lods.length - 1)]!
          const mesh = new THREE.InstancedMesh(
            lod.geometry, this.material(atmosphere, part.surface, part.material), cap,
          )
          mesh.name = `scatter-${id}-v${v}-b${band}-${part.slot}`
          mesh.count = 0
          mesh.frustumCulled = false
          ;(band === 0 ? this.nearGroup : this.farGroup).add(mesh)
          meshes.push(mesh)
        }
        this.batches.set(key, { meshes, cap, count: 0 })
      }
    }
  }

  get instances(): number {
    let n = 0
    for (const b of this.batches.values()) n += b.count
    return n
  }

  update(cx: number, cz: number, force = false): void {
    if (force || this.forceNext || !Number.isFinite(this.builtX[0]!)) {
      this.forceNext = false
      for (let b = 0; b < BANDS.length; b++) this.rebuild(b, cx, cz)
      return
    }
    // ONE band per call, the one that is stalest RELATIVE TO ITS OWN TOLERANCE.
    //
    // This replaced a single 12 m trigger that rebuilt band 0 and then rotated
    // the rest one per frame, and the reason is the fade rather than the cost.
    // A form grows in over a window proportional to its cut distance, so near
    // the front of the near ring that window is only about 25 m — and a 12 m
    // streaming step therefore jumped half of it in one frame. MEASURED, at 12 m
    // a pine arrived 30 px tall in a single step; at 3 m the same step is 1.6.
    // A pop is not really a question of what is drawn, it is a question of how
    // much can change in one streaming update.
    //
    // It is also CHEAPER than the rotation it replaced, which is what makes it
    // affordable: the fine-stride near bands are small and refresh often, the
    // 8,000-cell outer bands are large and refresh rarely, and the old scheme
    // paid for all five every 12 m regardless. ~1,600 cells a frame at 35 m/s
    // against ~1,900.
    let pick = -1
    let worst = 1
    for (let b = 0; b < BANDS.length; b++) {
      const dx = cx - this.builtX[b]!
      const dz = cz - this.builtZ[b]!
      const r = Math.sqrt(dx * dx + dz * dz) / BAND_TOLERANCE[b]!
      if (r > worst) { worst = r; pick = b }
    }
    // A ratio cannot starve a near band: a rebuild zeroes that band's own
    // staleness, so the far bands win at most one frame each.
    if (pick >= 0) this.rebuild(pick, cx, cz)
  }

  /** Allocated instance slots. `BAND_CAP` is a memory bill as well as a budget. */
  budget(): { batches: number; meshes: number; slots: number; mib: number } {
    let meshes = 0
    let slots = 0
    for (const b of this.batches.values()) {
      meshes += b.meshes.length
      slots += b.cap * b.meshes.length
    }
    // One instance matrix is a mat4 of f32.
    return { batches: this.batches.size, meshes, slots, mib: (slots * 64) / 1048576 }
  }

  private recomputeRollMax(): void {
    const perBiome = new Float64Array(BIOME_COUNT)
    for (const c of this.choices) perBiome[c.biome]! += c.perM2
    let max = 0
    for (let b = 0; b < BIOME_COUNT; b++) if (perBiome[b]! > max) max = perBiome[b]!
    this.rollMax = max * BASE_CELL * BASE_CELL
  }

  private h(ix: number, iz: number, channel: number): number {
    return spatialHash(ix, iz, channel, this.worldSeed)
  }

  private takeCand(): Cand {
    const c = this.candPool.pop()
    if (c) return c
    return {
      key: '', d2: 0, fade: 1, height: 0, x: 0, y: 0, z: 0, scale: 1, yaw: 0, lift: 0, footprint: 0, proxy: null,
    }
  }

  private rebuild(band: number, cx: number, cz: number): void {
    const stride = BAND_STRIDE[band]!
    const cell = BASE_CELL
    const outer = BANDS[band]!
    const inner = band === 0 ? 0 : BANDS[band - 1]!
    // The most of the authored density this band's lattice can express.
    const ceil = BAND_KEEP_CEIL[band]!
    this.builtX[band] = cx
    this.builtZ[band] = cz
    // ALWAYS the fine-cell area. Far bands visit every Nth fine cell, so
    // density falls as 1/stride² — but a cell that rolls a tree at distance
    // rolls the SAME tree up close (same i, j, same hash). Using the coarse
    // area here would make far cells place more often than their fine
    // counterparts, so a tree would VANISH as you drove toward it.
    const area = cell * cell
    const outer2 = outer * outer
    const inner2 = inner * inner
    for (const [key, b] of this.batches) {
      if (key.endsWith(`#${band}`)) b.count = 0
    }
    if (band === 0) { this.obstacles.length = 0; this.solids.length = 0 }

    // Return previous candidates to the pool before gathering this band.
    for (let n = 0; n < this.cands.length; n++) this.candPool.push(this.cands[n]!)
    this.cands.length = 0

    // Align the iteration to the stride grid so band 1's (i, j) are a subset
    // of band 0's, not a phase-shifted sample of their own.
    const i0 = Math.floor((cx - outer) / cell / stride) * stride
    const i1 = Math.ceil((cx + outer) / cell / stride) * stride
    const j0 = Math.floor((cz - outer) / cell / stride) * stride
    const j1 = Math.ceil((cz + outer) / cell / stride) * stride

    for (let j = j0; j <= j1; j += stride) {
      for (let i = i0; i <= i1; i += stride) {
        const x = (i + this.h(i, j, 3)) * cell
        const z = (j + this.h(i, j, 5)) * cell
        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > outer2 || d2 <= inner2) continue

        // ── two free rejections, before any noise is sampled ────────────────
        // Both are exact upper bounds, so neither can drop a cell that would
        // have placed. They are what pays for the fine lattice reaching 200 m:
        // band 1 visits 9,900 cells and the pair reject the great majority of
        // them for two integer hashes and no heightfield work at all.
        const rank = cellRank(i, j, this.h(i, j, 31))
        // `THIN_MAX` is the largest full-density radius any def can have, so
        // this is the loosest threshold on offer at this distance.
        if (rank >= Math.min(thinKeep(THIN_MAX2 / d2), 1, ceil)) continue
        const roll = this.h(i, j, 7)
        if (roll > this.rollMax) continue

        const weights = this.weights
        const acc = this.acc
        weights.set(this.world.weightsAt(x, z))
        // Grove sampled once per cell so canopy and understory share the same
        // stand/clearing field.
        const grove = this.world.groveAt(x, z)
        // Square the grove so mid values thin harder — clearings open up and
        // the remaining mass reads as stands rather than a soft density fade.
        const treeRate = grove * grove
        // Softer than trees: still empties clearings without wiping the floor.
        const understoryRate = grove
        // Overgrown landscapePopulate: keep trees/props off the dirt corridor,
        // but only in meadow/forest (no desert/alpine dirt tracks).
        const pathLand = this.world.pathLandAt(x, z)
        const pathDist = pathLand > 0.2 ? this.world.distToPath(x, z) : 1e9
        let total = 0
        for (let k = 0; k < this.choices.length; k++) {
          const c = this.choices[k]!
          let rate = weights[c.biome]! * c.perM2 * area
          if (TREE_IDS.has(c.id)) {
            if (pathDist < ROAD_HALF + 4) rate = 0
            else rate *= treeRate
          } else if (UNDERSTORY_IDS.has(c.id)) {
            if (pathDist < ROAD_HALF + 1) rate = 0
            else rate *= understoryRate
          } else if (pathDist < ROAD_HALF * 0.85) {
            rate *= 0.08
          }
          total += rate
          acc[k] = total
        }
        if (total <= 0) continue
        // Cell contents are a pure function of (i, j, worldSeed). Caps never
        // decide WHAT lives here — only whether this cell is drawn right now.
        // Same channel and same comparison as the `rollMax` prefilter above, so
        // the prefilter is exactly a conservative form of this test.
        if (roll > total) continue
        // Choose in proportion to the same products that produced `total`, so
        // the mix at a boundary is the blend of the two sets, not the winner's.
        const pick = this.h(i, j, 13) * total
        let k = 0
        while (k < acc.length - 1 && acc[k]! < pick) k++
        const choice = this.choices[k]!
        const info = this.defs.get(choice.id)
        if (!info) continue

        // ── the distance thinning ───────────────────────────────────────────
        // `kr` is deliberately UNCAPPED so it grows without bound as d -> 0:
        // the fade divides by it, and a capped value would leave a high-ranked
        // form permanently shrunken everywhere inside its own full-density
        // radius instead of full size.
        const kr = thinKeep((info.d0 * info.d0) / Math.max(d2, 1))
        if (rank >= Math.min(kr, 1, ceil)) continue
        // Grow in over the approach rather than appearing at full size. `rank`
        // is strictly below `kr` here, so `fade` is strictly positive and no
        // instance is ever composed at zero scale.
        let fade = (1 - rank / kr) / THIN_FADE
        fade = fade >= 1 ? 1 : fade * fade * (3 - 2 * fade)
        // The world's own edge is the last hard appearance boundary in the
        // system, and it cannot be fixed by the rank cut: nothing is placed
        // past `SCATTER_REACH`, so an instance at 1299 m has nothing to fade in
        // FROM — it simply enters the circle. Measured before this taper, the
        // worst fade any appearing instance arrived at was 0.703, and every one
        // of those was at 1292-1295 m. Only the outermost band has a reach
        // edge; every inner boundary is a rung change on a form that goes on
        // existing in the next band out.
        if (band === BANDS.length - 1) {
          const edge = (SCATTER_REACH - Math.sqrt(d2)) / (SCATTER_REACH * REACH_FADE)
          if (edge < 1) fade *= edge * edge * (3 - 2 * edge)
        }

        const y = this.world.heightAt(x, z)
        // 1.2 m of FREEBOARD for a form that must stay dry; `wade` metres of
        // DEPTH for one that may stand in the water. Two different quantities,
        // and the first version subtracted one from the other — `waterLevel +
        // 1.2 - wade` — which at a 2.2 m wade allowed only 1.0 m of depth. On a
        // 1-in-5 shelf that is a five-metre strip of shoreline, and at 120
        // instances per square kilometre nothing ever landed in it: measured, 0
        // of 48 near obstacles were over water.
        const floor = choice.wade > 0
          ? this.world.waterLevel - choice.wade
          : this.world.waterLevel + 1.2
        if (y < floor) continue
        // The slope test costs two extra heightfield evaluations, and a
        // heightfield evaluation is ten noise taps. Band 0 pays for it because
        // a boulder leaning out of a cliff face at ten metres is a bug you can
        // see; band 2 is 260-900 m away under aerial perspective and paying
        // 14,000 noise taps a rebuild to straighten a silhouette three pixels
        // tall is how a streaming system turns into a frame hitch.
        // `roughSlopeAt` rather than two more `heightAt` evaluations — see the
        // note on that method. Same threshold question, a quarter of the cost.
        //
        // EVERY BAND, and it used to be `band < 2` on a cost argument. That made
        // the placed set disagree with itself across 230 m: a boulder leaning
        // out of a cliff existed in the far bands and was rejected by the near
        // ones, so it VANISHED as the player drove up to it. The cost argument
        // was also aimed at the wrong count — this runs on cells that have
        // already passed the roll and the rank test, a few thousand a rebuild,
        // not on the ~14,000 cells the old comment claimed.
        if (this.world.roughSlopeAt(x, z, 1.5) > choice.maxSlope) continue

        const v = info.variants > 1 ? Math.floor(this.h(i, j, 17) * info.variants) % info.variants : 0
        const key = `${choice.id}#${v}#${band}`
        if (!this.batches.has(key)) continue
        // The fade multiplies the SCALE, so the collision proxy and the obstacle
        // footprint below shrink with the drawn mesh and physics keeps agreeing
        // with pixels.
        const scale = (choice.scaleLo + this.h(i, j, 19) * (choice.scaleHi - choice.scaleLo)) * fade
        const yaw = this.h(i, j, 29) * Math.PI * 2
        const lift = info.lift[v]! * scale - info.height[v]! * scale * EMBED
        const cand = this.takeCand()
        cand.key = key
        cand.d2 = d2
        cand.fade = fade
        cand.height = info.height[v]!
        cand.x = x
        cand.y = y
        cand.z = z
        cand.scale = scale
        cand.yaw = yaw
        cand.lift = lift
        cand.footprint = info.footprint[v]! * scale
        cand.proxy = info.proxy[v] ?? null
        this.cands.push(cand)
      }
    }

    // Nearest-first within each batch. Under the kart is stable; only the
    // far fringe of a capped batch streams as the camera moves.
    this.cands.sort((a, b) => a.d2 - b.d2 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    for (let n = 0; n < this.cands.length; n++) {
      const c = this.cands[n]!
      const batch = this.batches.get(c.key)
      if (!batch || batch.count >= batch.cap) continue
      const idx = batch.count
      this.p.set(c.x, c.y + c.lift, c.z)
      this.e.set(0, c.yaw, 0)
      this.q.setFromEuler(this.e)
      this.s.set(c.scale, c.scale, c.scale)
      this.m.compose(this.p, this.q, this.s)
      for (const mesh of batch.meshes) mesh.setMatrixAt(idx, this.m)
      batch.count = idx + 1
      if (this.dumpSink) {
        this.dumpSink.push({
          x: c.x, z: c.z, band, key: c.key, scale: c.scale, fade: c.fade,
          // Drawn height in metres. The pop-in gate turns this into PIXELS,
          // which is the only unit in which an appearance is or is not visible.
          h: c.height * c.scale,
        })
      }

      if (band === 0) {
        this.obstacles.push({ x: c.x, z: c.z, r: c.footprint })
        const poly = c.proxy
        if (poly) {
          this.solids.push({
            x: c.x, y: c.y + c.lift, z: c.z,
            cos: Math.cos(c.yaw), sin: Math.sin(c.yaw), scale: c.scale,
            poly,
            topY: c.y + c.lift + poly.top * c.scale,
            radius: poly.radius * c.scale,
          })
        }
      }
    }

    for (const [key, b] of this.batches) {
      if (!key.endsWith(`#${band}`)) continue
      for (const mesh of b.meshes) {
        mesh.count = b.count
        // An InstancedMesh with count 0 still issues a draw. There are ~100 of
        // these and most are empty in any one biome, so this is most of the
        // scatter's draw-call cost recovered for one boolean.
        mesh.visible = b.count > 0
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  /**
   * Make every batch drawable for one `compileAsync`, then restore.
   *
   * WebGPU compiles a pipeline the first time a (geometry, material) pair is
   * drawn, and `compileAsync` walks the scene graph — so it skips anything
   * currently `visible = false`, which is most of the scatter most of the time
   * (a meadow draws none of the alpine set). The result is a compile stall the
   * first time each batch streams in, which is exactly when the player is
   * driving into somewhere new. Measured: the first six seconds of the perf
   * harness's driving scene ran at 24-25 ms against 17-18 ms for the last six.
   */
  prepareForCompile(): () => void {
    const saved: [THREE.InstancedMesh, boolean, number][] = []
    for (const b of this.batches.values()) {
      for (const m of b.meshes) {
        saved.push([m, m.visible, m.count])
        m.visible = true
        if (m.count === 0) m.count = 1
      }
    }
    return () => {
      for (const [m, visible, count] of saved) { m.visible = visible; m.count = count }
    }
  }

  dispose(): void {
    for (const b of this.batches.values()) for (const m of b.meshes) m.dispose()
  }
}
