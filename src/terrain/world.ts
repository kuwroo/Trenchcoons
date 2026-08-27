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

/** Where the rim mountains start and finish rising, metres from the origin. */
const RIM_START = 2700
const RIM_END = 4400
/** Peak height the rim adds, metres. */
const RIM_HEIGHT = 520

/** Resolution of the baked palette maps. 512 over 8 km is 16 m per texel. */
const PALETTE_RES = 512
/** Resolution of the baked deform-response maps. These vary slowly. */
const RESPONSE_RES = 256

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
  readonly litMap = makeMap(PALETTE_RES)
  /** RGB = the slope/exposure colour, A = grass density / 2. */
  readonly cliffMap = makeMap(PALETTE_RES)
  /** (refill, maskLife, collapse, dry), log-encoded. */
  readonly responseTimeMap = makeMap(RESPONSE_RES)
  /** (darken, chroma/1.5, expose, edge). */
  readonly responseToneMap = makeMap(RESPONSE_RES)
  readonly span = WORLD_HALF * 2
  /** `log(1 + t)` normaliser the response maps were encoded with. Read by
   *  src/deform/field.ts, which decodes them. */
  readonly responseLogMax = RESPONSE_LOG_MAX

  private readonly nBase: Noise2
  private readonly nDetail: Noise2
  private readonly nTemp: Noise2
  private readonly nMoist: Noise2
  private readonly nRelief: Noise2
  private readonly forced: BiomeId | null

  /** Scratch, so `climateAt` never allocates. */
  private readonly scratch: Climate = {
    temperature: 0.5, moisture: 0.5, elevation: 0, coastality: 0,
    weights: new Float32Array(BIOME_COUNT), dominant: 'meadow',
  }
  private readonly blendWeights = new Float32Array(BIOME_COUNT)

  constructor(rng: Rng, options: TerrainWorldOptions = {}) {
    const fork = rng.fork('terrain')
    this.nBase = valueNoise(fork.fork('base'))
    this.nDetail = valueNoise(fork.fork('detail'))
    this.nTemp = valueNoise(fork.fork('temperature'))
    this.nMoist = valueNoise(fork.fork('moisture'))
    this.nRelief = valueNoise(fork.fork('relief'))
    this.forced = options.forced ?? null
    // Partly filled, so a rim of shore shows all the way round.
    this.waterLevel = this.continent(LAGOON.x, LAGOON.z) - LAGOON.depth * 0.46
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
    h += this.nBase(x / 380, z / 380) * 150
    h += this.nBase(x / 150 + 13.5, z / 150 - 7.25) * 55
    h += this.nDetail(x / 88 - 41.0, z / 88 + 22.5) * 17
    h += this.nDetail(x / 46 + 91.5, z / 46 - 63.0) * 5
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
    const coastality = smoothstep(26, 2, above) * 0.92

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
  responseAt(x: number, z: number): DeformResponse {
    const c = this.climateAt(x, z)
    const out: Record<string, number> = {
      maxDepth: 0, refill: 0, maskLife: 0, collapse: 0, wet: 0, dry: 0,
      darken: 0, chroma: 0, expose: 0, edge: 0, drag: 0, grip: 0,
    }
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const r = biomeResponse(BIOME_IDS[i]!) as unknown as Record<string, number>
      for (const k in out) out[k]! += w * r[k]!
    }
    return out as unknown as DeformResponse
  }

  /** Blended light and air, for the per-frame atmosphere grade. */
  gradeAt(x: number, z: number): {
    fog: THREE.Color; fogDensity: number; sunTint: THREE.Color; ambient: number
    label: string
  } {
    const c = this.climateAt(x, z)
    const fog = new THREE.Color(0, 0, 0)
    const sun = new THREE.Color(0, 0, 0)
    let density = 0
    let ambient = 0
    const tmp = new THREE.Color()
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = c.weights[i]!
      if (w <= 0) continue
      const s = BIOME_STYLES[BIOME_IDS[i]!]
      fog.add(tmp.setHex(s.fog, THREE.SRGBColorSpace).multiplyScalar(w))
      sun.add(tmp.setHex(s.sunTint, THREE.SRGBColorSpace).multiplyScalar(w))
      density += w * s.fogDensity
      ambient += w * s.ambient
    }
    return { fog, fogDensity: density, sunTint: sun, ambient, label: c.dominant }
  }

  /** Grass clumps per square metre here, before the distance falloff. */
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
    return { density, id, scale: scale || 1 }
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
    const cBase = new THREE.Color()
    const cShadow = new THREE.Color()
    const cLit = new THREE.Color()
    const cCliff = new THREE.Color()
    const tmp = new THREE.Color()
    for (let j = 0; j < PALETTE_RES; j++) {
      for (let i = 0; i < PALETTE_RES; i++) {
        const x = ((i + 0.5) / PALETTE_RES - 0.5) * this.span
        const z = ((j + 0.5) / PALETTE_RES - 0.5) * this.span
        const c = this.climateAt(x, z)
        cBase.setRGB(0, 0, 0); cShadow.setRGB(0, 0, 0)
        cLit.setRGB(0, 0, 0); cCliff.setRGB(0, 0, 0)
        let grass = 0
        for (let b = 0; b < BIOME_COUNT; b++) {
          const w = c.weights[b]!
          if (w <= 0) continue
          const s = BIOME_STYLES[BIOME_IDS[b]!]
          // Blended in sRGB, deliberately: these are AUTHORED colours and the
          // authored midpoint between two of them is the sRGB one. Blending
          // ART_BIBLE's snow and its dune in linear space produces a
          // conspicuously dark transition that neither biome contains.
          cBase.add(hexRgb(tmp, s.base).multiplyScalar(w))
          cShadow.add(hexRgb(tmp, s.shadow).multiplyScalar(w))
          cLit.add(hexRgb(tmp, s.lit).multiplyScalar(w))
          cCliff.add(hexRgb(tmp, s.cliff).multiplyScalar(w))
          grass += w * s.grassDensity
        }
        const o = (j * PALETTE_RES + i) * 4
        writeRgb(pb, o, cBase); pb[o + 3] = 255
        writeRgb(ps, o, cShadow); ps[o + 3] = 255
        writeRgb(pl, o, cLit); pl[o + 3] = 255
        writeRgb(pc, o, cCliff)
        pc[o + 3] = Math.round(clamp01(grass / 2) * 255)
      }
    }
    this.baseMap.needsUpdate = true
    this.shadowMap.needsUpdate = true
    this.litMap.needsUpdate = true
    this.cliffMap.needsUpdate = true

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
      this.baseMap, this.shadowMap, this.litMap, this.cliffMap,
      this.responseTimeMap, this.responseToneMap,
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
