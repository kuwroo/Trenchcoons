// Instanced grass.
//
// "can i have threejs grass" — this is it, and it is built out of the
// modeller's blade assets rather than a new mesh: `grass-tuft` and
// `grass-cluster` in assets/defs/scatter, through `ScatterLibrary`. Nothing in
// here generates geometry. The world team owns WHERE grass goes and how much of
// it there is; the asset library owns what a tuft looks like.
//
// Three things make it affordable:
//
//   BANDS. Three concentric rings around the camera, each drawing a coarser
//   rung of the asset's own LOD ladder at a lower density. The far ring is
//   sampled on a 3.4 m lattice and the near one on 1.1 m, so density falls with
//   distance without a per-instance distance test anywhere.
//
//   SIX DRAW CALLS, TOTAL. Two grass defs x three bands, each one
//   `InstancedMesh` whose `count` is set per rebuild. Grass is the asset in the
//   game most likely to eat the draw budget and it spends 0.4% of it.
//
//   STABLE PLACEMENT. Every clump's position comes from a hash of its lattice
//   cell, not from a stream, so the same clump is in the same place whatever
//   order the bands were built in and whichever direction the camera arrived
//   from. Without that, grass crawls and pops as you drive.
//
// Wind comes from the ONE global field (CLAUDE.md invariant). See the note on
// `iRot` for why a world-space gust has to be rotated into instance space.

import * as THREE from 'three/webgpu'
import { attribute, float, positionLocal, pow, vec2, vec3 } from 'three/tsl'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { PainterlyMaterial } from '../material/painterly'
import { ScatterLibrary } from '../assets'
import type { TerrainWorld } from '../terrain/world'
import { graded } from './surfaceGrade'

/** Ring outer radii, metres. */
const BANDS = [22, 60, 150] as const
/** Lattice the band is sampled on, metres. Coarser = fewer, larger clumps. */
const BAND_CELL = [0.62, 1.7, 3.2] as const
/** Extra thinning per band on top of the lattice. */
const BAND_THIN = [1, 0.5, 0.28] as const
/** Instance ceiling per band, per def. */
const BAND_CAP = [3600, 3000, 3000] as const
/**
 * Global density scale on the art-bible numbers.
 *
 * The biome table authors "clumps per square metre" as a look, and a clump here
 * is fourteen blades and 168 triangles. 0.5 is where the near ring lands at
 * ~95k triangles, which is a third of what the whole greybox used to cost and
 * reads as a full lawn at the driver's eye height.
 */
const DENSITY = 3.0
/** Tip travel at full gust, metres. */
const SWAY = 0.075
/** Steepest ground grass will grow on, radians. */
const MAX_SLOPE = 0.62

/** Cheap deterministic hash of two lattice indices. No Math.random, ever. */
function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), h | 1) >>> 0
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296
}

interface Batch {
  mesh: THREE.InstancedMesh
  root: THREE.InstancedBufferAttribute
  rot: THREE.InstancedBufferAttribute
  inv: THREE.InstancedBufferAttribute
  cap: number
}

export interface GrassOptions {
  /** Ids to draw, in the order a cell prefers them. */
  ids?: string[]
}

export class Grass {
  readonly group = new THREE.Group()
  private readonly batches: Batch[][] = []
  private readonly ids: string[]
  private readonly materials: PainterlyMaterial[] = []
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
    private readonly wind: WindField,
    library: ScatterLibrary,
    options: GrassOptions = {},
  ) {
    this.group.name = 'grass'
    this.ids = options.ids ?? ['grass-tuft', 'grass-cluster']

    for (const id of this.ids) {
      const part = library.asset(id, 0).parts[0]
      if (!part) throw new Error(`grass def "${id}" has no parts`)
      const height = Math.max(0.05, library.asset(id, 0).bounds.height)
      const material = this.buildMaterial(atmosphere, graded(part.surface, part.material), height)
      const row: Batch[] = []
      for (let b = 0; b < BANDS.length; b++) {
        const lod = part.lods[Math.min(b, part.lods.length - 1)]!
        const cap = BAND_CAP[b]!
        const mesh = new THREE.InstancedMesh(lod.geometry, material, cap)
        mesh.name = `grass-${id}-band${b}`
        mesh.count = 0
        // The batch surrounds the camera; culling it can only pop the whole
        // ring out at once, which is what `frustumCulled` on an InstancedMesh
        // does when the origin instance leaves the view.
        mesh.frustumCulled = false
        mesh.castShadow = false
        const root = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
        const rot = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
        const inv = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1)
        for (const a of [root, rot, inv]) a.setUsage(THREE.DynamicDrawUsage)
        mesh.geometry.setAttribute('iRoot', root)
        mesh.geometry.setAttribute('iRot', rot)
        mesh.geometry.setAttribute('iInv', inv)
        this.group.add(mesh)
        row.push({ mesh, root, rot, inv, cap })
      }
      this.batches.push(row)
    }
  }

  /**
   * The wind half of the material.
   *
   * `positionNode` is LOCAL space and the gust is world space, so the offset
   * has to come back through the instance's own yaw and scale or a clump facing
   * north bends south. `iRot` carries (cos yaw, sin yaw) and `iInv` the
   * reciprocal scale, both written once per rebuild — five floats an instance
   * against the alternative, which is a second matrix.
   */
  private buildMaterial(
    atmosphere: Atmosphere, params: PainterlyMaterial['params'], height: number,
  ): THREE.Material {
    const pm = new PainterlyMaterial(atmosphere, params)
    this.materials.push(pm)
    const root = vec2(attribute<'vec2'>('iRoot', 'vec2'))
    const rot = vec2(attribute<'vec2'>('iRot', 'vec2'))
    const inv = float(attribute<'float'>('iInv', 'float'))
    // Cubed-ish, so the blade BENDS rather than shearing: nearly nothing at the
    // base, everything at the tip.
    const weight = pow(positionLocal.y.div(float(height)).clamp(0, 1), float(1.7))
    const w = vec3(this.wind.sway(root, weight).mul(float(SWAY)))
    const local = vec3(
      w.x.mul(rot.x).sub(w.z.mul(rot.y)),
      w.y,
      w.x.mul(rot.y).add(w.z.mul(rot.x)),
    ).mul(inv)
    pm.material.positionNode = vec3(positionLocal.add(local))
    return pm.material
  }

  /** Number of live clumps. For the HUD and the acceptance test. */
  get instances(): number {
    let n = 0
    for (const row of this.batches) for (const b of row) n += b.mesh.count
    return n
  }

  /**
   * Re-centre.
   *
   * At most ONE band is rebuilt per call. A full rebuild is ~0.6 ms and the
   * near band re-snaps six times a second at racing speed; spreading it means
   * the cost never lands in one frame, and because placement is hashed rather
   * than streamed a half-updated set is still a correct set — just centred a
   * few metres behind.
   */
  update(cx: number, cz: number, force = false): void {
    const moved = !(Math.abs(cx - this.lastX) < 6 && Math.abs(cz - this.lastZ) < 6)
    if (moved) { this.dirty = true; this.lastX = cx; this.lastZ = cz }
    if (!this.dirty && !force) return
    if (force || !Number.isFinite(this.lastX)) {
      for (let b = 0; b < BANDS.length; b++) this.rebuild(b, cx, cz)
      this.dirty = false
      return
    }
    this.rebuild(this.nextBand, cx, cz)
    this.nextBand = (this.nextBand + 1) % BANDS.length
    if (this.nextBand === 0) this.dirty = false
  }

  private rebuild(band: number, cx: number, cz: number): void {
    const cell = BAND_CELL[band]!
    const outer = BANDS[band]!
    const inner = band === 0 ? 0 : BANDS[band - 1]!
    const thin = BAND_THIN[band]!
    const counts = new Array<number>(this.ids.length).fill(0)
    const i0 = Math.floor((cx - outer) / cell)
    const i1 = Math.ceil((cx + outer) / cell)
    const j0 = Math.floor((cz - outer) / cell)
    const j1 = Math.ceil((cz + outer) / cell)
    const area = cell * cell
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const jx = hash2(i, j, 11)
        const jz = hash2(i, j, 23)
        const x = (i + jx) * cell
        const z = (j + jz) * cell
        const d = Math.hypot(x - cx, z - cz)
        if (d > outer || d <= inner) continue
        const g = this.world.grassAt(x, z)
        if (!g.id || g.density <= 0) continue
        if (hash2(i, j, 41) > g.density * DENSITY * area * thin) continue
        const idx = this.ids.indexOf(g.id)
        if (idx < 0) continue
        const batch = this.batches[idx]![band]!
        const n = counts[idx]!
        if (n >= batch.cap) continue
        const y = this.world.heightAt(x, z)
        if (y < this.world.waterLevel + 0.4) continue
        // Slope test: a tuft standing on a 45-degree face reads as a mistake,
        // and every reference puts grass on the flats and bare rock on the
        // breaks. Two extra heightfield evaluations, so only the near band —
        // see the same note in scatter.ts. At 60 m a tuft is four pixels.
        if (band === 0) {
          const gx = this.world.heightAt(x + 0.9, z) - y
          const gz = this.world.heightAt(x, z + 0.9) - y
          if (Math.atan(Math.hypot(gx, gz) / 0.9) > MAX_SLOPE) continue
        }

        const yaw = hash2(i, j, 67) * Math.PI * 2
        const scale = g.scale * (0.72 + hash2(i, j, 89) * 0.66)
        this.p.set(x, y - 0.03, z)
        this.e.set(0, yaw, 0)
        this.q.setFromEuler(this.e)
        this.s.set(scale, scale * (0.85 + hash2(i, j, 97) * 0.4), scale)
        batch.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s))
        batch.root.setXY(n, x, z)
        batch.rot.setXY(n, Math.cos(yaw), Math.sin(yaw))
        batch.inv.setX(n, 1 / scale)
        counts[idx] = n + 1
      }
    }
    for (let k = 0; k < this.ids.length; k++) {
      const batch = this.batches[k]![band]!
      batch.mesh.count = counts[k]!
      batch.mesh.instanceMatrix.needsUpdate = true
      batch.root.needsUpdate = true
      batch.rot.needsUpdate = true
      batch.inv.needsUpdate = true
    }
  }

  dispose(): void {
    for (const row of this.batches) for (const b of row) b.mesh.dispose()
  }
}
