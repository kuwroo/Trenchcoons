// The world model: one heightfield, three continuous climate fields, and the
// biome classification that falls out of them.
//
// ART_BIBLE §5 is explicit that this is the only legitimate way to build the
// biomes: "Biomes are not painted regions with blend bands between them. They
// are a classification of continuous climate fields. Get the fields right and
// plausible transitions fall out for free." So there is no region map in this
// file, no adjacency graph and no special-case transition code path — ambiguity
// in the classifier IS the transition, and its width is set by how fast the
// fields change.
//
// The payoff is the one the art bible names: desert cannot touch snow, because
// getting from hot-dry to cold-dry means crossing the temperatures in between.
//
// Everything here is a pure function of a seeded noise table. The class also
// BAKES the classification into a handful of small textures, because the ground
// material and the deformation field both have to agree with the CPU about
// which biome a given square metre is, and the only way to guarantee that is
// for both to read the same numbers.

import * as THREE from 'three/webgpu'
import type { Rng } from '../core/rng'
import { clamp01, ridged, smoothstep, valueNoise, type Noise2 } from './noise'
import {
  BIOME_COUNT, BIOME_IDS, BIOME_STYLES, biomeResponse, type BiomeId, type BiomeStyle,
} from './biomes'
import type { DeformResponse } from '../deform/biome'
import {
  distToPath as overgrownDistToPath,
  pathCorridorWeight,
  ROAD_HALF,
} from '../world/pathCurve'

/** Half-extent of the playable world, metres. */
export const WORLD_HALF = 4000
/**
 * Fake planetary curvature. Makes the ground fall away below eye level at
 * ~3.1 km instead of ending in a straight seam against the sky.
 */
const CURVE_RADIUS = 400_000

/**
 * The lagoon, cut deterministically into the heightfield.
 *
 * Kept from the greybox because it is load-bearing for the palette: every
 * round-1 frame was "one green hue plus a pale sky", and a saturated COOL mass
 * next to the lime is where cliffs-tohad.jpg gets its chroma. It is also what
 * gives the coast biome somewhere to exist.
 */
export const LAGOON = { x: -900, z: -1420, r: 640, depth: 128 }

/** Absolute sea level, metres. See the note where `waterLevel` is assigned. */
export const SEA_LEVEL = -100

/** Where the rim mountains start and finish rising, metres from the origin. */
const RIM_START = 2700
const RIM_END = 4400
/** Peak height the rim adds, metres. */
const RIM_HEIGHT = 520

/** Resolution of the baked palette maps. 512 over 8 km is 16 m per texel. */
const PALETTE_RES = 512
/** Resolution of the baked deform-response maps. These vary slowly. */
const RESPONSE_RES = 256

/** Metres of water depth the bathymetry map's R channel spans. */
export const BATHY_RANGE = 48
/** Metres the finer G channel spans. The shore ladder lives inside this. */
export const BATHY_NEAR = 6

/**
 * Climate at a point, and the biome weights that follow from it.
 *
 * `weights` is normalised and ordered by `BIOME_IDS`. Reused across calls —
 * this is sampled hundreds of thousands of times during a clipmap rebuild and
 * allocating a Float32Array per sample is the difference between a 2 ms rebuild
 * and a 40 ms one.
 */
export interface Climate {
  temperature: number
  moisture: number
  /** Metres above the water line. */
  elevation: number
  /** 0 inland, 1 at the shore. See ART_BIBLE §5, "Coast is the exception". */
  coastality: number
  weights: Float32Array
  dominant: BiomeId
}

/** log-encode a duration into 0..1 so it survives an 8-bit channel. */
const LOG_MAX = Math.log(1 + 1600)
const encTime = (s: number): number => Math.log(1 + Math.max(0, s)) / LOG_MAX
const decTimeScale = LOG_MAX // the shader needs the same constant
export const RESPONSE_LOG_MAX = decTimeScale

function makeMap(res: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    new Uint8Array(res * res * 4), res, res, THREE.RGBAFormat, THREE.UnsignedByteType,
  )
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  // Decoded in the shader. Leaving this NoColorSpace keeps three from applying
  // a second conversion on top of the one the terrain material already does.
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

export interface TerrainWorldOptions {
  /** `?biome=` — force one classification everywhere, bypassing the fields.
   *  ARCHITECTURE's URL codec asks for exactly this. */
  forced?: BiomeId | null
}

export class TerrainWorld {
  readonly waterLevel: number
  /** Palette maps, world-space. RGB is authored sRGB; A carries a scalar. */
  readonly baseMap = makeMap(PALETTE_RES)
  readonly shadowMap = makeMap(PALETTE_RES)
  /** RGB = the lit stop, A = the biome's `rockSlope` (cosine of the tilt at
   *  which ground becomes rock). The alpha of these maps was unused. */
  readonly litMap = makeMap(PALETTE_RES)
  /** RGB = the slope/exposure colour, A = grass density / 2. */
  readonly cliffMap = makeMap(PALETTE_RES)
  /** RGB = the biome's SCATTER ROCK colour. Deliberately separate from
   *  `cliffMap` — see `BiomeStyle.rock`; a forest's hillside breaks to soil and
   *  a boulder standing in it is still stone. */
  readonly rockMap = makeMap(PALETTE_RES)
  /**
   * BATHYMETRY, for the water surface. R = water depth / `BATHY_RANGE`, G = the
   * same depth over the first `BATHY_NEAR` metres (so the shallows, where the
   * whole shore ladder lives, get the full 8-bit range instead of the bottom
   * eighth of it), B = continental slope / 1 rad, A unused.
   *
   * Baked here rather than in src/water because it is a property of the
   * HEIGHTFIELD and every other consumer of the heightfield's baked form is
   * already in this file. Free, too: the palette loop below already evaluates
   * `climateAt` at each texel and `heightAt` reuses that through the memo.
   *
   * 16 m per texel is coarse for a foam line and that is fine — the OUTER edge
   * of the shore band is the depth buffer (water is opaque and terrain occludes
   * it), which is exact at any resolution. The map only sets how far INLAND
   * from that exact edge the band reaches, and the terrain's finest octave is a
   * 46 m wavelength, so a bilinear tap between 16 m texels is within about a
   * metre of the true depth everywhere the ladder is doing work.
   */
  readonly bathyMap = makeMap(PALETTE_RES)
  /** (refill, maskLife, collapse, dry), log-encoded. */
  readonly responseTimeMap = makeMap(RESPONSE_RES)
  /** (darken, chroma/1.5, expose, edge). */
  readonly responseToneMap = makeMap(RESPONSE_RES)
  readonly span = WORLD_HALF * 2
  /** `log(1 + t)` normaliser the response maps were encoded with. Read by
   *  src/deform/field.ts, which decodes them. */
  readonly responseLogMax = RESPONSE_LOG_MAX
  /** Root world seed (u32). Scatter and grass fold this into their lattice
   *  hashes so vegetation is a fixed function of `?seed=` like the heightfield. */
  readonly seed: number

  private readonly nBase: Noise2
  private readonly nDetail: Noise2
  private readonly nTemp: Noise2
  private readonly nMoist: Noise2
  private readonly nRelief: Noise2
  private forced: BiomeId | null

  /** Scratch, so `climateAt` never allocates. */
  private readonly scratch: Climate = {
    temperature: 0.5, moisture: 0.5, elevation: 0, coastality: 0,
    weights: new Float32Array(BIOME_COUNT), dominant: 'meadow',
  }
  private readonly blendWeights = new Float32Array(BIOME_COUNT)
  /**
   * One-entry memo on `climateAt`.
   *
   * Not a micro-optimisation: the classification is four noise taps plus six
   * `Math.exp` calls, and the hot callers ask for the SAME point two and three
   * times in a row. `grassAt(x, z)` classifies, then `heightAt(x, z)` classifies
   * again to find the biome relief; `responseAt` and `gradeAt` do the same. The
   * grass rebuild runs that pattern a few thousand times per band and the driving
   * scene rebuilds a band six times a second.
   *
   * Safe because `climateAt` already returns the shared `scratch` — a caller
   * that held the result across another call was already reading mutated data,
   * so there is no contract here to break. `heightAt` passes the elevation in,
   * and the elevation is a pure function of (x, z), so a hit cannot be stale.
   */
  private memoX = Number.NaN
  private memoZ = Number.NaN

  constructor(rng: Rng, options: TerrainWorldOptions = {}) {
    this.seed = rng.seed
    const fork = rng.fork('terrain')
    this.nBase = valueNoise(fork.fork('base'))
    this.nDetail = valueNoise(fork.fork('detail'))
    this.nTemp = valueNoise(fork.fork('temperature'))
    this.nMoist = valueNoise(fork.fork('moisture'))
    this.nRelief = valueNoise(fork.fork('relief'))
    this.forced = options.forced ?? null
    // SEA LEVEL IS AN ABSOLUTE, and the old formula put it UNDERGROUND.
    //
    // `continent(LAGOON) - depth*0.46` evaluated to about -204 m while the
    // lagoon bowl it was meant to fill bottoms out at -145 m, so the water plane
    // sat 59 m BELOW the deepest ground in the world and nothing was ever
    // visible. That is the "where's the sea next to the coast?" report: the
    // coast biome classifies correctly off `above = h - waterLevel`, so beaches
    // were being drawn along a shoreline that had no water in it.
    //
    // Chosen from the height distribution rather than from the bowl. Measured
    // over an 8 km box on a 25 m grid, the share of ground under a candidate
    // level is:
    //
    //   -140 m  5.7%     -60 m  16.4%      0 m  31.5%
    //   -100 m  9.9%     -30 m  22.5%     30 m  42.7%
    //
    // -100 m floods a tenth of the world — enough for real coastline wherever a
    // basin reaches it, including filling the lagoon bowl to roughly a 250 m
    // radius — while leaving the meadow, the car spawn (-67 m) and every hill
    // dry. Raising it further starts drowning the drivable middle of the map.
    this.waterLevel = SEA_LEVEL
    this.bake()
  }

  /**
   * Force (or clear) a single biome over the whole world, then rebake.
   * Forge Environments and `?biome=` both need this without rebuilding the
   * noise tables.
   */
  setForced(id: BiomeId | null): void {
    this.forced = id
    this.memoX = Number.NaN
    this.memoZ = Number.NaN
    this.bake()
  }

  /** Re-resolve palette + response maps after a live `BIOME_STYLES` edit. */
  rebake(): void {
    this.memoX = Number.NaN
    this.memoZ = Number.NaN
    this.bake()
  }

  // ── the heightfield ───────────────────────────────────────────────────────

  /**
   * Continental relief, before any biome adds its own.
   *
   * This is the field the CLIMATE reads, and it must not depend on the climate
   * or the classification would be circular. Same octave ladder the greybox
   * shipped, so the world is recognisably the same place.
   */
  private continent(x: number, z: number): number {
    let h = 0
    // AMPLITUDE TO WAVELENGTH IS THE WHOLE THING, and the greybox ladder had it
    // wrong by about a factor of five at every scale. Measured over a 6 km box
    // by sampling the drawn height (`__trench.heightAt`) on an 8 m grid:
    //
    //   slope        median 28.0deg   p90 45.0deg   p99 55.1deg   max 69.1deg
    //
    // A 28-degree median is a black-diamond ski run and 45 degrees is unwalkable,
    // so the ENTIRE map was steeper than mountain terrain — which is exactly the
    // "hills too steep, unnatural" report. Real landscapes are the opposite
    // shape: strongly right-skewed, dominated by gentle ground with steep
    // features as the exception. Rolling pasture runs a 2-6 degree median; even
    // hilly countryside sits around 8-15; sustained slopes above ~35 do not
    // survive because that is roughly the angle of repose for soil, and anything
    // steeper sheds its regolith and becomes bare rock.
    //
    // The old ladder asked for 150 m of relief across a 380 m wavelength — a
    // 1:2.5 ratio, which is a Himalayan valley wall, and then summed three more
    // octaves almost as steep on top of it. Natural relief of that size belongs
    // on a 2-4 km wavelength (1:15 to 1:25). So the octaves keep their heights,
    // which is what gives the world its vistas, and are stretched out to the
    // wavelengths that height actually occurs over:
    //
    //   octave   was            now            ratio
    //   1        150 m / 380    190 m / 2400   1:12.6
    //   2         55 m / 150     62 m /  900   1:14.5
    //   3         17 m /  88     19 m /  380   1:20
    //   4          5 m /  46      6 m /  150   1:25
    //   5        —               1.6 m /  62   1:39   new, ground undulation
    //
    // Amplitudes fall faster than wavelengths across the ladder (a Hurst-like
    // cascade), so each finer octave is gentler than the one above it rather
    // than equally steep. That is what makes small-scale terrain read as texture
    // on a landform instead of as more landform.
    h += this.nBase(x / 2400, z / 2400) * 190
    h += this.nBase(x / 900 + 13.5, z / 900 - 7.25) * 62
    h += this.nDetail(x / 380 - 41.0, z / 380 + 22.5) * 19
    h += this.nDetail(x / 150 + 91.5, z / 150 - 63.0) * 6
    h += this.nDetail(x / 62 + 17.0, z / 62 - 29.0) * 1.6
    h -= (x * x + z * z) / (2 * CURVE_RADIUS)
    // THE RIM. A ring of real mountains around the playable area.
    //
    // This replaces the greybox's instanced cone "skyline", and the reason is
    // not tidiness. The cones were a ring of 130 scaled `ConeGeometry` at
    // 2.4-3.8 km from the WORLD ORIGIN, which is fine from the origin and
    // catastrophic anywhere else: standing at (3000, -2520) — a perfectly
    // ordinary place to drive to — put the camera INSIDE the ring, and the
    // capture came back as two 40-degree navy pyramids with a strip of desert
    // under them. A backdrop that is only correct from one spot is not a
    // backdrop.
    //
    // Real terrain has none of that problem: it is shaded by the same material
    // as the ground you are standing on, it takes aerial perspective for free,
    // the temperature lapse turns its summits alpine by itself, and you can
    // drive up it. `ridged` rather than plain noise because ART_BIBLE §4 asks
    // for "sharp dark rock ridges punching through" and says they must be
    // deliberate rather than a noise artefact.
    //
    // 900 m wavelength, which is not a look choice: the clipmap draws ground at
    // this distance with 35-70 m cells, and a shorter wavelength would alias
    // into a shimmering mess as the rings re-snap.
    const rr = Math.hypot(x, z)
    if (rr > RIM_START) {
      const t = smoothstep(RIM_START, RIM_END, rr)
      h += t * (ridged(this.nBase, x / 900 + 4.5, z / 900 - 8.5) * RIM_HEIGHT + 40)
    }
    // The lagoon bowl.
    const d = Math.hypot(x - LAGOON.x, z - LAGOON.z) / LAGOON.r
    if (d < 1) {
      const t = 1 - d
      h -= t * t * (3 - 2 * t) * LAGOON.depth
    }
    return h
  }

  /**
   * The surface, biome relief included.
   *
   * The second term is the "rock form changes with the biome" half of the
   * biome rule: alpine adds 26 m of ridged crease, desert adds 14 m of long
   * smooth dune, wetland adds 2.5 m of nearly nothing. Driving from one into
   * the other changes the SHAPE of the ground under the wheels, not only its
   * colour.
   */
  heightAt(x: number, z: number): number {
    const h = this.continent(x, z)
    const c = this.climateAt(x, z, h)
    let amp = 0
    let scale = 0
    let ridge = 0
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const s = BIOME_STYLES[BIOME_IDS[i]!]
      amp += w * s.relief
      scale += w * s.reliefScale
      ridge += w * s.reliefRidge
    }
    if (amp < 0.01) return h
    const u = x / Math.max(20, scale)
    const v = z / Math.max(20, scale)
    const smoothN = this.nRelief(u, v)
    const r = ridge > 0.01 ? ridged(this.nRelief, u * 1.7 + 5.5, v * 1.7 - 2.5) - 0.4 : 0
    return h + amp * (smoothN * (1 - ridge) + r * ridge * 1.6)
  }

  /**
   * The height a wheel or a prop should sit at.
   *
   * Identical to `heightAt`, and that is the point. The greybox needed a
   * separate `groundAt` because its ground mesh was 19 m quads and linear
   * interpolation across one departed from the analytic surface by up to 1.7 m
   * — two wheel diameters of buried or hovering. The clipmap in `clipmap.ts`
   * puts 0.55 m cells under the camera, where the finest terrain octave has a
   * 46 m wavelength, so the drawn surface and the analytic one now differ by
   * under a millimetre and the distinction has stopped being real.
   */
  groundAt(x: number, z: number): number { return this.heightAt(x, z) }

  /**
   * Tilt from the CONTINENTAL field alone, radians. A cheap stand-in for
   * `slopeAt` on the streaming hot path.
   *
   * Two forward differences on `continent` instead of eight full `heightAt`
   * evaluations, and `continent` is the half of the heightfield that does not
   * touch the climate classification — so this costs eight noise taps where the
   * honest version costs eight classifications as well. The approximation is
   * sound because the term it drops is the biome relief, whose wavelengths are
   * 95-260 m against amplitudes of 1.5-34 m: it contributes at most a couple of
   * degrees, while the continental octaves it keeps (380 m over 150 m, 150 m over
   * 55 m, 88 m over 17 m, 46 m over 5 m) carry essentially all of the slope.
   *
   * Used only for "may a tuft or a boulder stand here", which is a threshold test
   * with a hard visual consequence and no physical one. Anything that has to
   * AGREE with the drawn surface — spawn validation, the vehicle — still uses
   * `slopeAt` and `heightAt`.
   */
  roughSlopeAt(x: number, z: number, r = 1): number {
    const h = this.continent(x, z)
    const dx = this.continent(x + r, z) - h
    const dz = this.continent(x, z + r) - h
    return Math.atan(Math.hypot(dx, dz) / r)
  }

  /** Worst tilt over a ring of radius `r`, radians. */
  slopeAt(x: number, z: number, r = 1.35): number {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const h = this.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r)
      if (h < lo) lo = h
      if (h > hi) hi = h
    }
    return Math.atan((hi - lo) / (2 * r))
  }

  // ── the climate fields ────────────────────────────────────────────────────

  /**
   * Temperature, moisture, coastality and the biome weights they imply.
   *
   * @param elevation Pass the continental height if you already have it; this
   *   is called from inside `heightAt` and re-deriving it would recurse.
   */
  climateAt(x: number, z: number, elevation?: number): Climate {
    const c = this.scratch
    if (x === this.memoX && z === this.memoZ) return c
    this.memoX = x
    this.memoZ = z
    const h = elevation ?? this.continent(x, z)
    const above = h - this.waterLevel
    c.elevation = above

    if (this.forced) {
      c.temperature = 0.5
      c.moisture = 0.5
      c.coastality = this.forced === 'coast' ? 1 : 0
      c.weights.fill(0)
      c.weights[BIOME_IDS.indexOf(this.forced)] = 1
      c.dominant = this.forced
      return c
    }

    // TEMPERATURE — "falls with elevation, falls toward the world's polar axis".
    // +Z is the pole. The lapse rate is what puts alpine on the summits, so it
    // is deliberately strong: 200 m of climb is worth a third of the range.
    const tNoise = this.nTemp(x / 760, z / 760) * 0.34
      + this.nTemp(x / 2100 + 31.5, z / 2100 - 12.5) * 0.20
    const temperature = clamp01(
      0.60 - above / 620 * 0.34 - (z / WORLD_HALF) * 0.40 + tNoise,
    )
    // MOISTURE — "noise + proximity to water". Plus a longitudinal trend, so
    // there is a dry side of the world to put a desert on and driving +x is a
    // reliable way to find it.
    const dLagoon = Math.hypot(x - LAGOON.x, z - LAGOON.z)
    const nearWater = smoothstep(LAGOON.r * 2.6, LAGOON.r * 0.9, dLagoon)
    const mNoise = this.nMoist(x / 700 + 7.5, z / 700 + 3.5) * 0.36
      + this.nMoist(x / 1900 - 44.5, z / 1900 + 61.0) * 0.18
    const moisture = clamp01(
      0.50 - (x / WORLD_HALF) * 0.30 + nearWater * 0.42 + mNoise
      - smoothstep(40, 340, above) * 0.16,
    )
    // COASTALITY — a function of distance to sea level, not of climate.
    //
    // The band was `smoothstep(26, 2, above)`, and an 81x81 census over the whole
    // 8x8 km world found coast occupying 0.1% of it at a MEAN ELEVATION OF -193 m
    // — i.e. the only places classified as beach were underwater. ART_BIBLE §5
    // calls coast/lagoon the showcase biome and specifies "grassland -> beach ->
    // sea" wherever any land biome meets the water; a 24 m-tall elevation window
    // around a bowl whose walls fall 128 m over 640 m is a few metres of ground.
    //
    // 64 m down to 1 m widens it to a band you can drive along, and the upper
    // edge is a HEIGHT rather than a distance on purpose: it follows the shoreline
    // for free, it is wider where the shore is shallow and narrower where it is
    // steep, and it needs no distance-to-water field. The 0.95 cap leaves a
    // little land weight everywhere so the beach still "inherits a tint from
    // whichever biome it borders" (§5) instead of switching to pure sand.
    const coastality = smoothstep(64, 1, above) * 0.95

    c.temperature = temperature
    c.moisture = moisture
    c.coastality = coastality

    // Whittaker-style soft classification. Each land biome is a Gaussian in
    // (temperature, moisture); the weights are the normalised responses. There
    // is no threshold anywhere, so there is no seam anywhere.
    const w = c.weights
    let total = 0
    for (let i = 0; i < BIOME_COUNT; i++) {
      const k = KERNELS[i]!
      if (k === null) { w[i] = 0; continue }
      const dt = (temperature - k[0]) / k[2]
      const dm = (moisture - k[1]) / k[3]
      const v = Math.exp(-(dt * dt + dm * dm))
      w[i] = v
      total += v
    }
    const land = 1 - coastality
    const inv = total > 1e-6 ? land / total : 0
    for (let i = 0; i < BIOME_COUNT; i++) w[i]! *= inv
    w[COAST_INDEX] = coastality

    let best = 0
    let bestI = 0
    for (let i = 0; i < BIOME_COUNT; i++) {
      if (w[i]! > best) { best = w[i]!; bestI = i }
    }
    c.dominant = BIOME_IDS[bestI]!
    return c
  }

  /** Convenience: the winning biome at a point. */
  dominantAt(x: number, z: number): BiomeId { return this.climateAt(x, z).dominant }

  /** Blended deformation response — the fix for "marks only exist on the pan".
   *  Every square metre of the world now has a response of its own. */
  private readonly responseOut: Record<string, number> = {
    maxDepth: 0, refill: 0, maskLife: 0, collapse: 0, wet: 0, dry: 0,
    darken: 0, chroma: 0, expose: 0, edge: 0, drag: 0, grip: 0,
  }

  responseAt(x: number, z: number): DeformResponse {
    // Allocation-free. The deformation system calls this eight times a frame —
    // once per wheel in `sampleVehicle` and once per wheel in `applyToVehicle`
    // — and a twelve-field record per call is 480 short-lived objects a second
    // on the hot path of the thing the frame budget is tightest around.
    const c = this.climateAt(x, z)
    const out = this.responseOut
    for (const k in out) out[k] = 0
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const r = biomeResponse(BIOME_IDS[i]!) as unknown as Record<string, number>
      for (const k in out) out[k]! += w * r[k]!
    }
    return out as unknown as DeformResponse
  }

  /** Blended light and air, for the per-frame atmosphere grade. */
  private readonly gradeOut = {
    fog: new THREE.Color(), sunTint: new THREE.Color(),
    fogDensity: 1, ambient: 1, label: 'meadow',
  }
  private readonly gradeTmp = new THREE.Color()

  gradeAt(x: number, z: number): {
    fog: THREE.Color; fogDensity: number; sunTint: THREE.Color; ambient: number
    label: string
  } {
    // Allocation-free: this runs every frame from the render loop, and three
    // `new THREE.Color` per call at 60 Hz is 180 short-lived objects a second
    // for a value that is immediately copied out.
    const c = this.climateAt(x, z)
    const fog = this.gradeOut.fog.setRGB(0, 0, 0)
    const sun = this.gradeOut.sunTint.setRGB(0, 0, 0)
    let density = 0
    let ambient = 0
    const tmp = this.gradeTmp
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const s = BIOME_STYLES[BIOME_IDS[i]!]
      fog.add(tmp.setHex(s.fog, THREE.SRGBColorSpace).multiplyScalar(w))
      sun.add(tmp.setHex(s.sunTint, THREE.SRGBColorSpace).multiplyScalar(w))
      density += w * s.fogDensity
      ambient += w * s.ambient
    }
    this.gradeOut.fogDensity = density
    this.gradeOut.ambient = ambient
    this.gradeOut.label = c.dominant
    return this.gradeOut
  }

  /**
   * Dirt-track mask, 0..1 — overgrown pathCurve corridor weight, only where
   * meadow+forest dominate. 0 in desert/alpine/coast/wetland.
   */
  pathAt(x: number, z: number): number {
    return pathCorridorWeight(x, z, 3.2) * this.pathLandAt(x, z)
  }

  /** Metres to nearest overgrown path (main / cross / spur). */
  distToPath(x: number, z: number): number {
    return overgrownDistToPath(x, z)
  }

  /** Meadow + forest weight, 0..1. Dirt paths are gated on this. */
  pathLandAt(x: number, z: number): number {
    const c = this.climateAt(x, z)
    let w = 0
    for (let i = 0; i < BIOME_COUNT; i++) {
      const id = BIOME_IDS[i]!
      if (id === 'meadow' || id === 'forest') w += c.weights[i]!
    }
    return w
  }

  /**
   * Tree-grove mask, 0..1. High = dense stand, low = clearing. Trees multiply
   * their placement rate by this so the forest reads as clumps with room
   * between them rather than a uniform lattice.
   */
  groveAt(x: number, z: number): number {
    const g = this.nBase(x / 110 + 2.1, z / 110 - 5.3) * 0.62
      + this.nDetail(x / 42 + 0.7, z / 42 + 3.4) * 0.38
    return smoothstep(-0.18, 0.42, g)
  }

  /** Grass clumps per square metre — uniform carpet, cleared on path/coast. */
  private readonly grassOut = { density: 0, id: '', scale: 1 }

  /** Allocation-free: the grass rebuild calls this once per lattice cell, which
   *  is four thousand times for one band. */
  grassAt(x: number, z: number): { density: number; id: string; scale: number } {
    const c = this.climateAt(x, z)
    let density = 0
    let scale = 0
    let best = 0
    let id = ''
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const s = BIOME_STYLES[BIOME_IDS[i]!]
      density += w * s.grassDensity
      scale += w * s.grassScale
      if (s.grassId && w > best) { best = w; id = s.grassId }
    }
    // Coast / beach carries no grass. Density was already 0 on the coast row,
    // but land biomes still bled tufts onto the strand through weight blend —
    // kill that with coastality so the shore stays sand.
    density *= 1 - c.coastality
    if (c.coastality > 0.45) id = ''
    // Overgrown grassField roadCorridor — only in meadow/forest.
    const pathLand = (c.weights[BIOME_IDS.indexOf('meadow')] ?? 0)
      + (c.weights[BIOME_IDS.indexOf('forest')] ?? 0)
    if (pathLand > 0.2) {
      const d = overgrownDistToPath(x, z)
      if (d < ROAD_HALF * 0.7) {
        density = 0
        id = ''
      } else if (d < ROAD_HALF * 1.05) {
        density *= 0.45
      }
    }
    this.grassOut.density = density
    this.grassOut.id = id
    this.grassOut.scale = scale || 1
    return this.grassOut
  }

  /** Style weights at a point, copied out so callers may keep them. */
  weightsAt(x: number, z: number, out = this.blendWeights): Float32Array {
    const c = this.climateAt(x, z)
    out.set(c.weights)
    return out
  }

  // ── baking ────────────────────────────────────────────────────────────────

  /**
   * Resolve the classification onto the GPU maps.
   *
   * BLENDED VALUES, NOT WEIGHTS, and that is the whole design. Six biomes do
   * not fit in an RGBA texture, so the alternative would have been two weight
   * textures plus a six-way palette lookup in the fragment shader. Baking the
   * already-blended colour instead costs four cheap taps, cannot disagree with
   * the CPU classification (it IS the CPU classification), and makes a biome
   * repaint a rebake rather than a shader change.
   */
  private bake(): void {
    const pb = this.baseMap.image.data as Uint8Array
    const ps = this.shadowMap.image.data as Uint8Array
    const pl = this.litMap.image.data as Uint8Array
    const pc = this.cliffMap.image.data as Uint8Array
    const pr = this.rockMap.image.data as Uint8Array
    const pba = this.bathyMap.image.data as Uint8Array
    const cBase = new THREE.Color()
    const cShadow = new THREE.Color()
    const cLit = new THREE.Color()
    const cCliff = new THREE.Color()
    const cRock = new THREE.Color()
    const tmp = new THREE.Color()
    for (let j = 0; j < PALETTE_RES; j++) {
      for (let i = 0; i < PALETTE_RES; i++) {
        const x = ((i + 0.5) / PALETTE_RES - 0.5) * this.span
        const z = ((j + 0.5) / PALETTE_RES - 0.5) * this.span
        // `heightAt` first, so `climateAt` below lands on the memo. Both orders
        // give the same numbers; this one costs one classification per texel
        // instead of two.
        const h = this.heightAt(x, z)
        const c = this.climateAt(x, z)
        cBase.setRGB(0, 0, 0); cShadow.setRGB(0, 0, 0)
        cLit.setRGB(0, 0, 0); cCliff.setRGB(0, 0, 0); cRock.setRGB(0, 0, 0)
        let grass = 0
        let rockSlope = 0
        // Overgrown dirt paths only in meadow + forest (not desert/alpine/…).
        let pathLand = 0
        for (let b = 0; b < BIOME_COUNT; b++) {
          const w = c.weights[b]!
          if (w <= 0) continue
          const id = BIOME_IDS[b]!
          const s = BIOME_STYLES[id]
          rockSlope += w * s.rockSlope
          // Blended in sRGB, deliberately: these are AUTHORED colours and the
          // authored midpoint between two of them is the sRGB one. Blending
          // ART_BIBLE's snow and its dune in linear space produces a
          // conspicuously dark transition that neither biome contains.
          cBase.add(hexRgb(tmp, s.base).multiplyScalar(w))
          cShadow.add(hexRgb(tmp, s.shadow).multiplyScalar(w))
          cLit.add(hexRgb(tmp, s.lit).multiplyScalar(w))
          cCliff.add(hexRgb(tmp, s.cliff).multiplyScalar(w))
          cRock.add(hexRgb(tmp, s.rock).multiplyScalar(w))
          grass += w * s.grassDensity
          if (id === 'meadow' || id === 'forest') pathLand += w
        }
        const o = (j * PALETTE_RES + i) * 4
        writeRgb(pb, o, cBase); pb[o + 3] = 255
        writeRgb(ps, o, cShadow); ps[o + 3] = 255
        writeRgb(pl, o, cLit)
        pl[o + 3] = Math.round(clamp01(rockSlope) * 255)
        writeRgb(pc, o, cCliff)
        pc[o + 3] = Math.round(clamp01(grass / 2) * 255)
        writeRgb(pr, o, cRock)
        pr[o + 3] = Math.round(clamp01(pathLand) * 255)
        const wet = this.waterLevel - h
        pba[o] = Math.round(clamp01(wet / BATHY_RANGE) * 255)
        pba[o + 1] = Math.round(clamp01(wet / BATHY_NEAR) * 255)
        // `roughSlopeAt` over the texel width, not `slopeAt`: the honest one is
        // eight `heightAt` calls, i.e. eight classifications, and at 262 144
        // texels that is two million of them in the constructor. The seabed
        // slope AT MAP RESOLUTION is also the thing the shore band wants — how
        // wide the shelf is, not how rough one square metre of it is.
        pba[o + 2] = Math.round(clamp01(this.roughSlopeAt(x, z, 16) / 0.7) * 255)
        pba[o + 3] = 255
      }
    }
    this.baseMap.needsUpdate = true
    this.shadowMap.needsUpdate = true
    this.litMap.needsUpdate = true
    this.cliffMap.needsUpdate = true
    this.rockMap.needsUpdate = true
    this.bathyMap.needsUpdate = true

    const rt = this.responseTimeMap.image.data as Uint8Array
    const rn = this.responseToneMap.image.data as Uint8Array
    for (let j = 0; j < RESPONSE_RES; j++) {
      for (let i = 0; i < RESPONSE_RES; i++) {
        const x = ((i + 0.5) / RESPONSE_RES - 0.5) * this.span
        const z = ((j + 0.5) / RESPONSE_RES - 0.5) * this.span
        const r = this.responseAt(x, z)
        const o = (j * RESPONSE_RES + i) * 4
        rt[o] = Math.round(clamp01(encTime(r.refill)) * 255)
        rt[o + 1] = Math.round(clamp01(encTime(r.maskLife)) * 255)
        rt[o + 2] = Math.round(clamp01(r.collapse / 3) * 255)
        rt[o + 3] = Math.round(clamp01(encTime(r.dry)) * 255)
        rn[o] = Math.round(clamp01(r.darken) * 255)
        rn[o + 1] = Math.round(clamp01(r.chroma / 1.5) * 255)
        rn[o + 2] = Math.round(clamp01(r.expose) * 255)
        rn[o + 3] = Math.round(clamp01(r.edge) * 255)
      }
    }
    this.responseTimeMap.needsUpdate = true
    this.responseToneMap.needsUpdate = true
  }

  dispose(): void {
    for (const t of [
      this.baseMap, this.shadowMap, this.litMap, this.cliffMap, this.rockMap,
      this.responseTimeMap, this.responseToneMap, this.bathyMap,
    ]) t.dispose()
  }
}

/** sRGB bytes of a hex, as 0..1 floats. No colour-space conversion. */
function hexRgb(out: THREE.Color, hex: number): THREE.Color {
  return out.setRGB(
    ((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255,
  )
}
function writeRgb(data: Uint8Array, o: number, c: THREE.Color): void {
  data[o] = Math.round(clamp01(c.r) * 255)
  data[o + 1] = Math.round(clamp01(c.g) * 255)
  data[o + 2] = Math.round(clamp01(c.b) * 255)
}

/**
 * Whittaker kernels: (temperature centre, moisture centre, temperature sigma,
 * moisture sigma). `null` for coast, which is not a climate biome — see
 * ART_BIBLE §5, "Coast is the exception".
 *
 * The sigmas are as important as the centres: they set how WIDE a transition
 * is, and therefore how far you drive before the world changes. Alpine's
 * moisture sigma is huge because cold is cold whether it is wet or dry.
 */
const KERNELS: readonly (readonly [number, number, number, number] | null)[] =
  BIOME_IDS.map((id) => {
    switch (id) {
      case 'alpine': return [0.10, 0.55, 0.21, 0.80] as const
      case 'desert': return [0.88, 0.16, 0.24, 0.22] as const
      case 'wetland': return [0.55, 0.96, 0.30, 0.18] as const
      case 'forest': return [0.48, 0.72, 0.25, 0.20] as const
      case 'meadow': return [0.62, 0.44, 0.30, 0.24] as const
      case 'coast': return null
      default: return null
    }
  })
const COAST_INDEX = BIOME_IDS.indexOf('coast')

export type { BiomeId, BiomeStyle }
export { BIOME_IDS, BIOME_STYLES }
