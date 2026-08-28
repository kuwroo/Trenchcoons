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
// THREE BANDS, like the grass, and for the same reason: a form's LOD rung is a
// property of the band it was placed in, so there is no per-instance distance
// test anywhere in the frame. Only one band is rebuilt per call.
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
import { PainterlyMaterial } from '../material/painterly'
import { ScatterLibrary } from '../assets'
import type { TerrainWorld } from '../terrain/world'
import { BIOME_COUNT, BIOME_IDS, BIOME_STYLES } from '../terrain/biomes'
import { buildProxy, type ProxyPoly } from './proxy'
import { biomeTint, graded } from './surfaceGrade'

/**
 * Band outer radii, metres.
 *
 * 55 rather than 80 for the LOD0 ring, and it is the cheapest 5 ms in the build.
 * The scatter library's conifer LOD0 is 712 triangles (it went up from 402 when
 * the tiers became real thick plates, which was the right call), band 0 is the
 * only band that casts into the sun cascades, and the forest authors 8000
 * conifers per square kilometre — so at an 80 m radius the near ring alone was
 * carrying ~1100 conifer instances at 712 triangles, drawn once for the frame
 * and again per cascade. The driving perf scene measured 21.8-23.4 ms p50 with
 * 0.9-1.4 M triangles at only 235-301 draw calls, i.e. nowhere near batch-bound.
 * Cutting the LOD0 radius from 80 m to 55 m is a 53% cut in that population and
 * costs nothing visible: LOD1 switches in at 55 m instead of 80 m, and the
 * library's own authored switch distances start at 200 m.
 *
 * THERE IS A FOURTH BAND NOW, and it draws the library's IMPOSTOR rather than a
 * mesh rung. Band 2 used to run to 900 m and hand ~2000 conifers their LOD2 at
 * 208 triangles each — 416k triangles of three-to-six-pixel trees, in a frame
 * measured at 1150k total. The impostor exists precisely for that job (the
 * modeller's `tieredCards` traces the real sawtooth profile with up-facing
 * normals so its value matches LOD0's rather than popping), and using it past
 * 560 m costs single-digit triangles per instance.
 *
 * It also buys 400 m of extra world: scatter now reaches 1300 m instead of 900 m,
 * which is the cheapest available answer to the vista captures having no content
 * and therefore no value structure at distance.
 */
const BANDS = [55, 230, 560, 1300] as const
/** Placement lattice per band, metres. */
const BAND_CELL = [3.4, 13, 26, 58] as const
/**
 * Instance ceiling per (def, variant, band).
 *
 * The band-2 ceiling is a FRAME BUDGET, not a memory one. A forest at 8000
 * conifers per square kilometre wants 17,000 instances in the 260-900 m
 * annulus; drawing them costs about 4 ms and they are two to six pixels tall
 * under 1.0x haze. The cap plus the 32 m lattice hands the horizon what it can
 * carry and spends the rest on the near field.
 */
// Trimmed ~20% across the board. These bite only in the dense biomes, and the
// perf scene shows exactly where: driving at 35 m/s through the forest the frame
// carries 1113k triangles against 659k for the same car PARKED in the same place,
// because a kart crossing biome boundaries has several scatter sets populated at
// once while the bands catch up one per call.
const BAND_CAP = [340, 560, 700, 1100] as const
/** Fraction of its own height an instance is sunk into the ground. */
const EMBED = 0.06

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

function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), h | 1) >>> 0
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296
}

/** One (def, variant, band) draw. */
interface Batch {
  meshes: THREE.InstancedMesh[]
  cap: number
  count: number
}

interface Choice {
  biome: number
  id: string
  perM2: number
  scaleLo: number
  scaleHi: number
  maxSlope: number
}

interface DefInfo {
  id: string
  variants: number
  /** Per variant: the y-lift that puts the LOD0 floor on the ground. */
  lift: number[]
  height: number[]
  footprint: number[]
  proxy: (ProxyPoly | null)[]
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
  private lastX = Number.NaN
  private lastZ = Number.NaN
  private nextBand = 0
  private dirty = true

  constructor(
    atmosphere: Atmosphere,
    private readonly world: TerrainWorld,
    private readonly library: ScatterLibrary,
  ) {
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
        })
      }
    }

    if (this.choices.length > this.acc.length) {
      throw new Error(`scatter: ${this.choices.length} entries exceeds the acc buffer`)
    }
    const box = new THREE.Box3()
    for (const id of ids) {
      const variants = library.variants(id)
      const info: DefInfo = { id, variants, lift: [], height: [], footprint: [], proxy: [] }
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
            const lod = band === BANDS.length - 1
              ? (part.impostorShared ? part.lods[part.lods.length - 1]! : part.impostor)
              : part.lods[Math.min(band, part.lods.length - 1)]!
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
        })
      }
    }
    if (this.choices.length > this.acc.length) {
      throw new Error(`scatter: ${this.choices.length} entries exceeds the acc buffer`)
    }
    for (const id of needed) {
      if (!this.defs.has(id)) this.registerDef(atmosphere, id)
    }
    this.dirty = true
  }

  /** Ensure batches exist for a scatter def that was not in the table at boot. */
  private registerDef(atmosphere: Atmosphere, id: string): void {
    const variants = this.library.variants(id)
    const box = new THREE.Box3()
    const info: DefInfo = { id, variants, lift: [], height: [], footprint: [], proxy: [] }
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
    this.defs.set(id, info)

    for (let v = 0; v < variants; v++) {
      const asset = this.library.asset(id, v)
      for (let band = 0; band < BANDS.length; band++) {
        const key = `${id}#${v}#${band}`
        if (this.batches.has(key)) continue
        const cap = BAND_CAP[band]!
        const meshes: THREE.InstancedMesh[] = []
        for (const part of asset.parts) {
          const lod = band === BANDS.length - 1
            ? (part.impostorShared ? part.lods[part.lods.length - 1]! : part.impostor)
            : part.lods[Math.min(band, part.lods.length - 1)]!
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
    const moved = !(Math.abs(cx - this.lastX) < 12 && Math.abs(cz - this.lastZ) < 12)
    if (moved) { this.dirty = true; this.lastX = cx; this.lastZ = cz }
    if (force || !Number.isFinite(this.lastX)) {
      for (let b = 0; b < BANDS.length; b++) this.rebuild(b, cx, cz)
      this.dirty = false
      return
    }
    if (!this.dirty) return
    this.rebuild(this.nextBand, cx, cz)
    this.nextBand = (this.nextBand + 1) % BANDS.length
    if (this.nextBand === 0) this.dirty = false
  }

  private rebuild(band: number, cx: number, cz: number): void {
    const cell = BAND_CELL[band]!
    const outer = BANDS[band]!
    const inner = band === 0 ? 0 : BANDS[band - 1]!
    const area = cell * cell
    for (const [key, b] of this.batches) {
      if (key.endsWith(`#${band}`)) b.count = 0
    }
    if (band === 0) { this.obstacles.length = 0; this.solids.length = 0 }

    const i0 = Math.floor((cx - outer) / cell)
    const i1 = Math.ceil((cx + outer) / cell)
    const j0 = Math.floor((cz - outer) / cell)
    const j1 = Math.ceil((cz + outer) / cell)

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + hash2(i, j, 3)) * cell
        const z = (j + hash2(i, j, 5)) * cell
        const d = Math.hypot(x - cx, z - cz)
        if (d > outer || d <= inner) continue
        const weights = this.weights
        const acc = this.acc
        weights.set(this.world.weightsAt(x, z))
        let total = 0
        for (let k = 0; k < this.choices.length; k++) {
          const c = this.choices[k]!
          total += weights[c.biome]! * c.perM2 * area
          acc[k] = total
        }
        if (total <= 0) continue
        const roll = hash2(i, j, 7)
        if (roll > total) continue
        // Choose in proportion to the same products that produced `total`, so
        // the mix at a boundary is the blend of the two sets, not the winner's.
        const pick = hash2(i, j, 13) * total
        let k = 0
        while (k < acc.length - 1 && acc[k]! < pick) k++
        const choice = this.choices[k]!
        const info = this.defs.get(choice.id)
        if (!info) continue

        const y = this.world.heightAt(x, z)
        if (y < this.world.waterLevel + 1.2) continue
        // The slope test costs two extra heightfield evaluations, and a
        // heightfield evaluation is ten noise taps. Band 0 pays for it because
        // a boulder leaning out of a cliff face at ten metres is a bug you can
        // see; band 2 is 260-900 m away under aerial perspective and paying
        // 14,000 noise taps a rebuild to straighten a silhouette three pixels
        // tall is how a streaming system turns into a frame hitch.
        // `roughSlopeAt` rather than two more `heightAt` evaluations — see the
        // note on that method. Same threshold question, a quarter of the cost,
        // and band 1 alone asks it of ~1400 lattice cells per rebuild.
        if (band < 2 && this.world.roughSlopeAt(x, z, 1.5) > choice.maxSlope) continue

        const v = info.variants > 1 ? Math.floor(hash2(i, j, 17) * info.variants) % info.variants : 0
        const batch = this.batches.get(`${choice.id}#${v}#${band}`)
        if (!batch || batch.count >= batch.cap) continue
        const n = batch.count
        const scale = choice.scaleLo + hash2(i, j, 19) * (choice.scaleHi - choice.scaleLo)
        const yaw = hash2(i, j, 29) * Math.PI * 2
        const lift = info.lift[v]! * scale - info.height[v]! * scale * EMBED
        this.p.set(x, y + lift, z)
        this.e.set(0, yaw, 0)
        this.q.setFromEuler(this.e)
        this.s.set(scale, scale, scale)
        this.m.compose(this.p, this.q, this.s)
        for (const mesh of batch.meshes) mesh.setMatrixAt(n, this.m)
        batch.count = n + 1

        if (band === 0) {
          const r = info.footprint[v]! * scale
          this.obstacles.push({ x, z, r })
          const poly = info.proxy[v]
          if (poly) {
            this.solids.push({
              x, y: y + lift, z,
              cos: Math.cos(yaw), sin: Math.sin(yaw), scale,
              poly,
              topY: y + lift + poly.top * scale,
              radius: poly.radius * scale,
            })
          }
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
