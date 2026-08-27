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
import type { Atmosphere } from '../atmosphere/sky'
import { PainterlyMaterial } from '../material/painterly'
import { ScatterLibrary } from '../assets'
import type { TerrainWorld } from '../terrain/world'
import { BIOME_COUNT, BIOME_IDS, BIOME_STYLES } from '../terrain/biomes'
import { buildProxy, type ProxyPoly } from './proxy'
import { graded } from './surfaceGrade'

/** Band outer radii, metres. */
const BANDS = [80, 260, 900] as const
/** Placement lattice per band, metres. */
const BAND_CELL = [3.4, 11, 18] as const
/** Instance ceiling per (def, variant, band). */
const BAND_CAP = [560, 900, 1400] as const
/** Fraction of its own height an instance is sunk into the ground. */
const EMBED = 0.06

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
            const lod = part.lods[Math.min(band, part.lods.length - 1)]!
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
    const key = JSON.stringify(clean)
    const hit = this.byParams.get(key)
    if (hit) return hit.material
    const pm = new PainterlyMaterial(atmosphere, clean)
    this.byParams.set(key, pm)
    this.materials.push(pm)
    return pm.material
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
    const weights = new Float32Array(BIOME_COUNT)
    const acc = new Float64Array(this.choices.length)

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + hash2(i, j, 3)) * cell
        const z = (j + hash2(i, j, 5)) * cell
        const d = Math.hypot(x - cx, z - cz)
        if (d > outer || d <= inner) continue
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
        const gx = this.world.heightAt(x + 1.5, z) - y
        const gz = this.world.heightAt(x, z + 1.5) - y
        if (Math.atan(Math.hypot(gx, gz) / 1.5) > choice.maxSlope) continue

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

  dispose(): void {
    for (const b of this.batches.values()) for (const m of b.meshes) m.dispose()
  }
}
