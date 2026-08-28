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
import {
  attribute, float, positionLocal, pow, saturate, texture, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { PainterlyMaterial, type DeformHook } from '../material/painterly'
import { ScatterLibrary } from '../assets'
import type { TerrainWorld } from '../terrain/world'
import { biomeTint, graded } from './surfaceGrade'

/** Ring outer radii, metres. */
const BANDS = [22, 60, 150] as const
/**
 * Scale range on the authored tuft, multiplied by the biome's `grassScale`.
 *
 * Widened from 0.72..1.38 to 0.96..1.86, and it is a COVERAGE fix rather than a
 * size preference. shots/grass-close.png measured 41.9% of its foreground tiles
 * dead flat against 2.7% in refs/genshin/grasslands.jpg — bare untextured ground
 * showing between individual sprigs, where the reference's grass is a continuous
 * carpet with the ground only glimpsed through it. The lattice was already
 * saturated (at 0.9 clumps/m2 and the near band's 0.62 m cell, essentially every
 * cell carries a clump), so the missing coverage is per-clump WIDTH, not count —
 * and width is free where count costs a draw's worth of instances each.
 */
const SCALE_LO = 0.96
const SCALE_SPAN = 0.90
/**
 * Lattice the band is sampled on, metres. Coarser = fewer, larger clumps.
 *
 * The two outer figures went up (1.7 -> 2.1, 3.2 -> 4.6), and it is a CPU fix
 * that costs no instances. At the authored densities the per-cell placement
 * probability is above 1 in every band — the lattice, not the density, is what
 * limits the count — so band 2 was classifying 8836 lattice cells per rebuild in
 * order to place 3000 clumps, and throwing 66% of that work away against the cap.
 * A coarser lattice with the same cap places the same number of clumps from a
 * third fewer classifications. Full-rebuild cell count falls from ~18.9k to
 * ~12.5k, and at 35 m/s the near band re-snaps six times a second.
 */
const BAND_CELL = [0.62, 2.1, 4.6] as const
/** Extra thinning per band on top of the lattice. */
const BAND_THIN = [1, 0.5, 0.28] as const
/** Instance ceiling per band, per def. */
const BAND_CAP = [3400, 2400, 2000] as const
/**
 * GROUND CLUTTER: a second, finer lattice in the NEAR BAND ONLY.
 *
 * The tuft lattice is 0.62 m and a tuft is 0.27 m across, so at a metre and a
 * half off the deck you are looking at the smooth terrain plane BETWEEN the
 * clumps. Measured: shots/grass-close.png's near band scored 0.0033 median tile
 * detail against refs/genshin/grasslands.jpg's 0.058, while the SAME meadow at
 * eye 6 (shots/biome-meadow.png) scores 0.0704 and passes above the reference.
 * The deficit is only in the last couple of metres, so the fix belongs only in
 * the near band.
 *
 * Geometry rather than a texture, on two grounds: the brief abandoned the
 * painterly overlay because it read as mottled camouflage, and raising the
 * ground material's own micro term instead was measured and rejected — 2.5x
 * moved the near band to only 0.0074 and pulled `npm run distinct`'s corridor
 * ratio from 2.05 to 1.74, eroding the tyre-mark contrast for no gain. The
 * reference's close-range detail is discrete objects anyway.
 */
const CLUTTER_ID = 'ground-sprig'
const CLUTTER_CELL = 0.30
const CLUTTER_CAP = 5200
/**
 * Thinning on the clutter, tuned against the structure gate's CEILING as well
 * as its floor. At 1.0 the sprigs took grass-close's median tile detail from
 * 0.0176 to 0.0322 — the intended fix — but pushed near-noon (eye 3.5) from
 * 0.0669 to 0.0943, outside the references' own 0.056-0.080 band and into
 * OVER-DETAILED. Detail has to land IN the band, not above it.
 */
const CLUTTER_THIN = 0.55
/**
 * Global density scale on the art-bible numbers.
 *
 * The biome table authors "clumps per square metre" as a look, and a clump here
 * is fourteen blades and 168 triangles.
 *
 * 2.2 rather than 3.0, and it is paid for by the WIDTH increase in `SCALE_LO`
 * rather than given up: the same coverage from fewer, broader clumps. Two things
 * wanted it down. The near meadow captures measured median tile detail 0.102-0.111
 * against the structure gate's 0.031-0.093 band — OVER-DETAILED, which for
 * instanced grass means the blades are landing at roughly a pixel — and the
 * driving perf scene runs its cost through this number more directly than through
 * anything else in the file.
 */
const DENSITY = 2.2
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
    private readonly deform: DeformHook | null = null,
  ) {
    this.group.name = 'grass'
    this.ids = options.ids ?? ['grass-tuft', 'grass-cluster', CLUTTER_ID]

    for (const id of this.ids) {
      const part = library.asset(id, 0).parts[0]
      if (!part) throw new Error(`grass def "${id}" has no parts`)
      const height = Math.max(0.05, library.asset(id, 0).bounds.height)
      const material = this.buildMaterial(atmosphere, graded(part.surface, part.material), height)
      const row: Batch[] = []
      for (let b = 0; b < BANDS.length; b++) {
        const lod = part.lods[Math.min(b, part.lods.length - 1)]!
        // 1, not 0, for the clutter's unused bands: a zero-length
        // InstancedBufferAttribute is a zero-size WebGPU binding, and the
        // renderer throws `Binding size ... is zero` once per draw — 264 of them
        // across the shot set. The mesh still never draws, because `count` stays
        // at 0.
        const cap = id === CLUTTER_ID ? (b === 0 ? CLUTTER_CAP : 1) : BAND_CAP[b]!
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
    const root = vec2(attribute<'vec2'>('iRoot', 'vec2'))
    const rot = vec2(attribute<'vec2'>('iRot', 'vec2'))
    const inv = float(attribute<'float'>('iInv', 'float'))

    // ── the biome tint ───────────────────────────────────────────────────────
    //
    // Sampled from the terrain's OWN baked palette map at the clump's root, so
    // grass cannot disagree with the ground it grows out of. That is worth more
    // than a per-instance colour computed on the CPU: it is one texture fetch, it
    // costs the rebuild nothing, and it is by construction the same
    // classification the ground material, the deform response and the scatter
    // set are reading. Drive into the desert and the tufts go straw because the
    // sand under them did.
    //
    // A RATIO against the meadow, not the colour itself — the tuft keeps its own
    // authored albedo, its vertical gradient and its ramp, and only the biome's
    // departure from the hub is applied. So the meadow is untouched by
    // construction (the ratio is 1 there), which is what makes this safe to add
    // to a surface that was already graded against the reference.
    const tint = biomeTint(texture(this.world.litMap, this.mapUv(root)).rgb, 0x85ce4c, 0.9)

    const pm = new PainterlyMaterial(atmosphere, params, null, { tint })
    this.materials.push(pm)

    // Cubed-ish, so the blade BENDS rather than shearing: nearly nothing at the
    // base, everything at the tip.
    const weight = pow(positionLocal.y.div(float(height)).clamp(0, 1), float(1.7))
    const w = vec3(this.wind.sway(root, weight).mul(float(SWAY)))
    let local = vec3(
      w.x.mul(rot.x).sub(w.z.mul(rot.y)),
      w.y,
      w.x.mul(rot.y).add(w.z.mul(rot.x)),
    ).mul(inv)

    // ── the deformation field: grass is CRUSHED, not merely stained ───────────
    //
    // The fifth user complaint, and the half of it that was still visibly true.
    // The marks are stamped world-wide and the ground material reads them, but
    // nothing in src/world read the field at all — so on the meadow a tyre track
    // was a 4 cm albedo darkening seen THROUGH 0.8 undisturbed tufts per square
    // metre, and it measured as a soft stain rather than a rut. Flattening the
    // blades is most of what a wheel actually does to grass and it is what makes
    // the corridor legible from a driver's eye.
    //
    // Applied along the local up-axis and scaled by the same `weight` the wind
    // uses, so the clump folds from the base instead of sinking into the ground,
    // and pushed sideways along the field's own slope so the two ruts splay
    // outward the way crushed grass does. Sampled at the ROOT, in the vertex
    // stage, at one texture tap per vertex.
    if (this.deform) {
      const d = this.deform.shade(vec3(root.x, float(0), root.y))
      const crush = saturate(d.mask).mul(0.94).toVar()
      // Fold: keep a tenth of the height at full crush, so the corridor still
      // reads as flattened grass rather than as bare ground.
      local = vec3(local.add(vec3(
        d.slope.x.clamp(-1, 1).negate().mul(crush).mul(weight).mul(0.5),
        positionLocal.y.negate().mul(crush).mul(weight),
        d.slope.y.clamp(-1, 1).negate().mul(crush).mul(weight).mul(0.5),
      )))
    }
    pm.material.positionNode = vec3(positionLocal.add(local))
    return pm.material
  }

  /** World XZ -> the terrain's baked-map UV. */
  private mapUv(root: Node<'vec2'>): Node<'vec2'> {
    return vec2(root.div(float(this.world.span)).add(0.5))
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
        // `roughSlopeAt`, not two more `heightAt` calls: the honest version paid
        // two full biome classifications per lattice cell to answer a threshold
        // question about whether a tuft looks wrong, and the term it drops (the
        // biome relief, 1.5-34 m of amplitude over 95-260 m of wavelength) is
        // worth a couple of degrees against a 35-degree threshold.
        if (band === 0 && this.world.roughSlopeAt(x, z, 0.9) > MAX_SLOPE) continue

        const yaw = hash2(i, j, 67) * Math.PI * 2
        const scale = g.scale * (SCALE_LO + hash2(i, j, 89) * SCALE_SPAN)
        this.p.set(x, y - 0.03, z)
        this.e.set(0, yaw, 0)
        this.q.setFromEuler(this.e)
        // WIDE AND SHORT, not uniformly bigger. The XZ scale above carries the
        // coverage the reference has (see SCALE_LO) and the Y factor takes the
        // height back out of it: at a uniform 0.96-1.86 the tufts stood roughly a
        // metre tall, which buried the chase camera in shots/tracks-grass.png and
        // made the capture a picture of the inside of a lawn. Genshin's turf is
        // dense and low with the occasional taller clump, which is exactly a wide
        // footprint and a Y factor under one.
        this.s.set(scale, scale * (0.58 + hash2(i, j, 97) * 0.36), scale)
        batch.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s))
        batch.root.setXY(n, x, z)
        batch.rot.setXY(n, Math.cos(yaw), Math.sin(yaw))
        batch.inv.setX(n, 1 / scale)
        counts[idx] = n + 1
      }
    }
    // ── the clutter pass ─────────────────────────────────────────────────────
    // Near band only, its own finer lattice, and independent of `grassAt`'s
    // single-id choice: this is not a biome's grass, it is ground cover under
    // whatever grass the biome does have. Gated on the same density field, so
    // it stops at the sand exactly where the tufts do.
    const ci = this.ids.indexOf(CLUTTER_ID)
    if (band === 0 && ci >= 0) {
      const cc = CLUTTER_CELL
      const cBatch = this.batches[ci]![0]!
      let n = 0
      const ca = cc * cc
      const ci0 = Math.floor((cx - outer) / cc)
      const ci1 = Math.ceil((cx + outer) / cc)
      const cj0 = Math.floor((cz - outer) / cc)
      const cj1 = Math.ceil((cz + outer) / cc)
      for (let j = cj0; j <= cj1 && n < cBatch.cap; j++) {
        for (let i = ci0; i <= ci1 && n < cBatch.cap; i++) {
          const x = (i + hash2(i, j, 131)) * cc
          const z = (j + hash2(i, j, 137)) * cc
          if (Math.hypot(x - cx, z - cz) > outer) continue
          const g = this.world.grassAt(x, z)
          if (!g.id || g.density <= 0) continue
          if (hash2(i, j, 149) > g.density * DENSITY * ca * CLUTTER_THIN) continue
          const y = this.world.heightAt(x, z)
          if (y < this.world.waterLevel + 0.4) continue
          if (this.world.roughSlopeAt(x, z, 0.9) > MAX_SLOPE) continue
          const yaw = hash2(i, j, 151) * Math.PI * 2
          const scale = g.scale * (SCALE_LO + hash2(i, j, 157) * SCALE_SPAN)
          this.p.set(x, y - 0.02, z)
          this.e.set(0, yaw, 0)
          this.q.setFromEuler(this.e)
          this.s.set(scale, scale * (0.7 + hash2(i, j, 163) * 0.5), scale)
          cBatch.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s))
          cBatch.root.setXY(n, x, z)
          cBatch.rot.setXY(n, Math.cos(yaw), Math.sin(yaw))
          cBatch.inv.setX(n, 1 / scale)
          n++
        }
      }
      counts[ci] = n
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
