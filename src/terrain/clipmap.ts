// The terrain mesh: a camera-centred geometry clipmap.
//
// WHY THIS REPLACES THE 8 KM PLANE, in one paragraph, because it is the fix for
// the user's "dont see tire marks" as much as it is a terrain upgrade. The
// greybox drew one 420x420 plane over 8 km — 19 m quads — and a tyre rut is
// 30 cm wide. On that mesh the deformation field's vertical displacement is
// mathematically unresolvable, so M4 shipped a single finely tessellated
// rectangle (the "sand pan") as the one place in the world where a mark could
// be geometry. Everywhere else there was no mark surface. A clipmap puts 0.55 m
// cells under the camera WHEREVER the camera is, so the pan stops being special
// and the whole world becomes the pan.
//
// It is also cheaper: 129k triangles against the plane's 353k, with 55 cm of
// resolution at the player instead of 19 m.
//
// STRUCTURE. Nine levels. Level L has MxM cells of size 0.55 * 2^L metres,
// centred on the camera and snapped to a 2-cell grid of its own level so the
// lattice never crawls under the player. Every level but the finest has a
// rectangular hole where the level inside it draws.
//
// THE HOLE IS ONE CELL SMALLER than the child's guaranteed coverage, and the
// levels are sunk 1.5 cm per rung. That pair of decisions is what makes the
// seams free: a child snapped to its own grid can sit up to one parent cell off
// the parent's centre, so a hole sized exactly to the child would expose a gap
// on one side; undersizing it by a cell means the child always overhangs, and
// sinking the parent means the depth test resolves the overlap in the child's
// favour without a stencil, a skirt or a per-frame index rebuild.

import * as THREE from 'three/webgpu'

/** Cells per side, per level. Divisible by 4 — see `HOLE`. */
const M = 96
/** Finest cell, metres. */
const BASE_CELL = 0.55
/** Levels. 96 * 0.55 * 2^8 = 13.5 km across at the coarsest. */
const LEVELS = 9
/**
 * Half-width of the hole in a level's own cells.
 *
 * The child covers M/4 = 24 of this level's cells either side of ITS centre,
 * and its centre is within one of this level's cells of ours, so 23 is the
 * largest hole guaranteed to be covered. See the header.
 */
const HOLE = M / 4 - 1
/**
 * Per-level sink, metres. Resolves the one-cell overlap ring.
 *
 * Has to be comfortably larger than the shadow cascades' depth bias, not merely
 * larger than a depth-buffer step. At 1.5 cm the coarse level sat inside the
 * fine level's shadow bias and every clipmap ring shadowed the one inside it —
 * the whole near field came back sky-blue because it was reading as occluded.
 * 5 cm x 8 rungs is 40 cm of droop at the coarsest ring, 3.4 km away.
 */
const SINK = 0.05

export type HeightFn = (x: number, z: number) => number

class Level {
  readonly mesh: THREE.Mesh
  readonly cell: number
  /** Heights on the level's own lattice, row-major, (M+1)^2. */
  private h = new Float32Array((M + 1) * (M + 1))
  private scratch = new Float32Array((M + 1) * (M + 1))
  private readonly position: THREE.BufferAttribute
  private readonly normal: THREE.BufferAttribute
  /** Lattice index of the origin, in cells. */
  private oi = Number.NaN
  private oj = Number.NaN

  constructor(
    readonly level: number, material: THREE.Material, private readonly heightAt: HeightFn,
  ) {
    this.cell = BASE_CELL * 2 ** level
    const nv = M + 1
    const pos = new Float32Array(nv * nv * 3)
    const nor = new Float32Array(nv * nv * 3)
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nv; i++) {
        const o = (j * nv + i) * 3
        pos[o] = (i - M / 2) * this.cell
        pos[o + 1] = 0
        pos[o + 2] = (j - M / 2) * this.cell
        nor[o + 1] = 1
      }
    }
    // Indices, built once: the hole is fixed in this level's own frame.
    const idx: number[] = []
    const lo = M / 2 - HOLE
    const hi = M / 2 + HOLE
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        if (level > 0 && i >= lo && i < hi && j >= lo && j < hi) continue
        const a = j * nv + i
        const b = a + 1
        const c = a + nv
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    const geo = new THREE.BufferGeometry()
    this.position = new THREE.BufferAttribute(pos, 3)
    this.normal = new THREE.BufferAttribute(nor, 3)
    this.position.setUsage(THREE.DynamicDrawUsage)
    this.normal.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.position)
    geo.setAttribute('normal', this.normal)
    geo.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : idx)
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.name = `terrain-L${level}`
    // A level surrounds the camera by construction, so culling it can only ever
    // cost a bounding-sphere test — and the shadow cascades need it anyway.
    this.mesh.frustumCulled = false
    // Finer levels sit HIGHER, so the depth test resolves the one-cell overlap
    // ring in favour of the better approximation without a stencil or a skirt.
    this.mesh.position.y = -SINK * level
  }

  /** Move to the snapped origin nearest (cx, cz). Returns true if it moved. */
  update(cx: number, cz: number): boolean {
    // Snapped to TWO cells, not one: at a one-cell snap the triangulation of
    // the lattice flips every step and the whole surface shimmers.
    const step = this.cell * 2
    const ni = Math.round(cx / step) * 2
    const nj = Math.round(cz / step) * 2
    if (ni === this.oi && nj === this.oj) return false
    const nv = M + 1
    const full = !Number.isFinite(this.oi)
      || Math.abs(ni - this.oi) > M || Math.abs(nj - this.oj) > M
    const di = full ? 0 : ni - this.oi
    const dj = full ? 0 : nj - this.oj
    const ox = ni * this.cell
    const oz = nj * this.cell
    const src = this.h
    const dst = this.scratch
    // Reuse everything the window still covers; only the newly exposed band
    // costs a heightfield evaluation. At speed the finest level re-snaps ~30
    // times a second and this is the difference between 2 ms and 0.08 ms.
    for (let j = 0; j < nv; j++) {
      const sj = j + dj
      for (let i = 0; i < nv; i++) {
        const si = i + di
        const o = j * nv + i
        if (!full && si >= 0 && si < nv && sj >= 0 && sj < nv) {
          dst[o] = src[sj * nv + si]!
        } else {
          dst[o] = this.heightAt(ox + (i - M / 2) * this.cell, oz + (j - M / 2) * this.cell)
        }
      }
    }
    this.h = dst
    this.scratch = src
    this.oi = ni
    this.oj = nj
    this.mesh.position.x = ox
    this.mesh.position.z = oz

    // Y and the normals, from the lattice we already have. Central differences
    // at the lattice spacing, one-sided at the border, which is exactly what
    // `computeVertexNormals` would produce and costs no heightfield samples.
    const pos = this.position.array as Float32Array
    const nor = this.normal.array as Float32Array
    const h = this.h
    for (let j = 0; j < nv; j++) {
      const jm = Math.max(0, j - 1)
      const jp = Math.min(M, j + 1)
      const dz = (jp - jm) * this.cell
      for (let i = 0; i < nv; i++) {
        const o = j * nv + i
        // Local Y is the heightfield exactly; the sink lives on the mesh's own
        // transform, so the two cannot cancel each other out.
        pos[o * 3 + 1] = h[o]!
        const im = Math.max(0, i - 1)
        const ip = Math.min(M, i + 1)
        const gx = (h[j * nv + ip]! - h[j * nv + im]!) / ((ip - im) * this.cell)
        const gz = (h[jp * nv + i]! - h[jm * nv + i]!) / dz
        const l = 1 / Math.hypot(gx, 1, gz)
        nor[o * 3] = -gx * l
        nor[o * 3 + 1] = l
        nor[o * 3 + 2] = -gz * l
      }
    }
    this.position.needsUpdate = true
    this.normal.needsUpdate = true
    return true
  }

  dispose(): void { this.mesh.geometry.dispose() }
}

export class TerrainClipmap {
  readonly group = new THREE.Group()
  private readonly levels: Level[] = []

  /**
   * @param fineMaterial Used on the two finest levels, which are the only ones
   *   whose cells are small enough for the deformation field's vertical
   *   displacement to mean anything.
   */
  constructor(fineMaterial: THREE.Material, coarseMaterial: THREE.Material, heightAt: HeightFn) {
    this.group.name = 'terrain-clipmap'
    for (let l = 0; l < LEVELS; l++) {
      const lv = new Level(l, l < 2 ? fineMaterial : coarseMaterial, heightAt)
      this.levels.push(lv)
      this.group.add(lv.mesh)
    }
  }

  /** Re-centre. Cheap when nothing crossed a snap boundary, which is most frames. */
  update(cx: number, cz: number): void {
    for (const l of this.levels) l.update(cx, cz)
  }

  /** Metres across, finest cell. Diagnostics only. */
  get finestCell(): number { return BASE_CELL }

  dispose(): void { for (const l of this.levels) l.dispose() }
}
