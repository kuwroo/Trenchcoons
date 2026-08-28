// Instanced silhouette grass — port of vendor/procedural-grass into WebGPU/TSL.
//
// Each instance is a crossed-card clump with an alpha cutout (grass-clump.png),
// lit by the shared painterly material + atmosphere, swayed by the ONE global
// WindField, crushed by the deformation field, and pushed by the kart.
//
// Placement is still the streaming hashed lattice driven by biome grassAt —
// only the mesh and the wind/interact response changed.

import * as THREE from 'three/webgpu'
import {
  attribute, float, fract, positionGeometry, pow, saturate, sin, smoothstep,
  texture, uniform, uv, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { PainterlyMaterial, type DeformHook } from '../material/painterly'
import { surface } from '../material/defs'
import type { TerrainWorld } from '../terrain/world'
import { biomeTint, graded } from './surfaceGrade'
import { createSilhouetteCrossGeometry } from '../vegetation/grass/silhouetteGeometry'
import { grassAlphaMap } from '../vegetation/grass/silhouetteTexture'

/** Ring outer radii, metres. Silhouette clumps read further than thin blades. */
const BANDS = [28, 70, 160] as const
const SCALE_LO = 0.85
const SCALE_SPAN = 0.55
/**
 * Lattice per band. Wider cells than the old blade tufts: each clump covers
 * more ground, so the near carpet no longer needs a second sprig lattice.
 */
const BAND_CELL = [0.85, 2.4, 5.2] as const
const BAND_THIN = [1, 0.55, 0.3] as const
const BAND_CAP = [2800, 2000, 1600] as const
/** Authored clump size, metres — matches the prototype defaults. */
const CLUMP_W = 0.96
const CLUMP_H = 0.78
const DENSITY = 1.6
const SWAY = 0.11
const MAX_SLOPE = 0.62
/** Kart interaction — ported from procedural-grass defaults. */
const PLAYER_RADIUS = 1.2
const PUSH = 0.55
const FLATTEN = 0.32

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

export class Grass {
  readonly group = new THREE.Group()
  private readonly batches: Batch[] = []
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
  private readonly kartPos = uniform(new THREE.Vector2(0, 0))
  private readonly kartOn = uniform(0)
  private readonly geometry: THREE.BufferGeometry
  private readonly alphaMap: THREE.Texture

  constructor(
    atmosphere: Atmosphere,
    private readonly world: TerrainWorld,
    private readonly wind: WindField,
    private readonly deform: DeformHook | null = null,
  ) {
    this.group.name = 'grass'
    this.geometry = createSilhouetteCrossGeometry(CLUMP_W, CLUMP_H)
    this.alphaMap = grassAlphaMap()
    const material = this.buildMaterial(atmosphere)
    for (let b = 0; b < BANDS.length; b++) {
      const cap = BAND_CAP[b]!
      const geo = b === 0 ? this.geometry : this.geometry.clone()
      const mesh = new THREE.InstancedMesh(geo, material, cap)
      mesh.name = `grass-sil-band${b}`
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.castShadow = false
      mesh.receiveShadow = true
      const root = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
      const rot = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
      const inv = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1)
      for (const a of [root, rot, inv]) a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('iRoot', root)
      geo.setAttribute('iRot', rot)
      geo.setAttribute('iInv', inv)
      this.group.add(mesh)
      this.batches.push({ mesh, root, rot, inv, cap })
    }
  }

  /** Kart world XZ for radial push/flatten. Pass null to disable. */
  setKartPos(x: number | null, z?: number): void {
    if (x === null || z === undefined) {
      this.kartOn.value = 0
      return
    }
    this.kartPos.value.set(x, z)
    this.kartOn.value = 1
  }

  private buildMaterial(atmosphere: Atmosphere): THREE.Material {
    const params = graded('grassMound', surface('grassMound'))
    const root = vec2(attribute<'vec2'>('iRoot', 'vec2'))
    const rot = vec2(attribute<'vec2'>('iRot', 'vec2'))
    const inv = float(attribute<'float'>('iInv', 'float'))
    // Phase / stiffness from the root hash — no extra vertex buffers.
    const phase = root.x.mul(12.9898).add(root.y.mul(78.233)).sin().mul(43758.5453).fract().mul(6.2831853)
    const stiff = root.x.mul(39.346).add(root.y.mul(11.135)).sin().mul(43758.5453).fract().mul(0.16).add(0.92)

    const tint = biomeTint(texture(this.world.litMap, this.mapUv(root)).rgb, 0x85ce4c, 0.9)
    const pm = new PainterlyMaterial(atmosphere, params, null, { tint })
    this.materials.push(pm)

    const mat = pm.material
    mat.side = THREE.DoubleSide
    mat.alphaMap = this.alphaMap
    mat.alphaTest = 0.15
    mat.transparent = false
    // Tip weight from authored UV (locked to the card, not bent by positionNode).
    const h = saturate(uv().y)
    const hBend = h.mul(h).mul(float(1.15).sub(h.mul(0.15)))
    const h2 = h.mul(h)

    // ── synced field wind (procedural-grass wave math on the global WindField)
    const wdir = this.wind.dirNode
    const across = vec2(wdir.y.negate(), wdir.x)
    const along = root.x.mul(wdir.x).add(root.y.mul(wdir.y))
    const side = root.x.mul(across.x).add(root.y.mul(across.y))
    const t = this.wind.timeNode.mul(0.85)
    const scale = float(0.38)
    const travel = float(1.45)
    const width = float(2.2)
    const localPhase = phase.mul(0.08)
    const p1 = along.mul(scale).sub(t.mul(travel)).add(localPhase)
    const p2 = along.mul(scale.mul(0.42)).sub(t.mul(travel.mul(0.48))).add(0.7)
    const g1 = pow(sin(p1).mul(0.5).add(0.5), width)
    const g2 = pow(sin(p2).mul(0.5).add(0.5), width.mul(0.85))
    const lean = sin(p1).mul(g1.mul(0.65).add(0.35)).mul(0.72)
      .add(sin(p2).mul(g2.mul(0.6).add(0.4)).mul(0.38))
    const breath = sin(t.mul(0.55).add(localPhase)).mul(0.5)
      .add(sin(t.mul(0.23)).mul(0.5)).mul(0.55)
    const windAmt = breath.mul(0.45).add(lean).mul(stiff).mul(this.wind.strengthNode)
    const windWorld = vec3(
      wdir.x.mul(windAmt).mul(hBend).mul(SWAY),
      windAmt.mul(hBend).mul(SWAY).mul(-0.16),
      wdir.y.mul(windAmt).mul(hBend).mul(SWAY),
    )
    // Into instance local space (same iRot dance as the old blade path).
    let local = vec3(
      windWorld.x.mul(rot.x).sub(windWorld.z.mul(rot.y)),
      windWorld.y,
      windWorld.x.mul(rot.y).add(windWorld.z.mul(rot.x)),
    ).mul(inv)

    // ── kart push / flatten ──────────────────────────────────────────────────
    const toBlade = root.sub(this.kartPos)
    const dist = toBlade.length()
    const influence = float(1).sub(smoothstep(float(0), float(PLAYER_RADIUS), dist))
      .mul(this.kartOn)
    const influence2 = influence.mul(influence)
    const pushDir = toBlade.div(dist.max(1e-4))
    const pushLocalX = pushDir.x.mul(rot.x).sub(pushDir.y.mul(rot.y))
    const pushLocalZ = pushDir.x.mul(rot.y).add(pushDir.y.mul(rot.x))
    local = vec3(local.add(vec3(
      pushLocalX.mul(influence2).mul(h2).mul(PUSH).mul(inv),
      influence2.mul(h).mul(FLATTEN).mul(float(CLUMP_H)).negate(),
      pushLocalZ.mul(influence2).mul(h2).mul(PUSH).mul(inv),
    )))

    // ── tyre crush from the deformation field ────────────────────────────────
    if (this.deform) {
      const d = this.deform.shade(vec3(root.x, float(0), root.y))
      const crush = saturate(d.mask).mul(0.94)
      const w = pow(saturate(positionGeometry.y.div(float(CLUMP_H))), float(1.7))
      local = vec3(local.add(vec3(
        d.slope.x.clamp(-1, 1).negate().mul(crush).mul(w).mul(0.5),
        positionGeometry.y.negate().mul(crush).mul(w),
        d.slope.y.clamp(-1, 1).negate().mul(crush).mul(w).mul(0.5),
      )))
    }

    mat.positionNode = vec3(positionGeometry.add(local))
    return mat
  }

  private mapUv(root: Node<'vec2'>): Node<'vec2'> {
    return vec2(root.div(float(this.world.span)).add(0.5))
  }

  get instances(): number {
    let n = 0
    for (const b of this.batches) n += b.mesh.count
    return n
  }

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
    const batch = this.batches[band]!
    let n = 0
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
        if (n >= batch.cap) continue
        const y = this.world.heightAt(x, z)
        if (y < this.world.waterLevel + 0.4) continue
        if (band === 0 && this.world.roughSlopeAt(x, z, 0.9) > MAX_SLOPE) continue

        const yaw = hash2(i, j, 67) * Math.PI * 2
        const scale = g.scale * (SCALE_LO + hash2(i, j, 89) * SCALE_SPAN)
        // Far bands: slightly larger cards, fewer of them.
        const bandBoost = 1 + band * 0.12
        this.p.set(x, y - 0.02, z)
        this.e.set(0, yaw, 0)
        this.q.setFromEuler(this.e)
        this.s.set(scale * bandBoost, scale * (0.85 + hash2(i, j, 97) * 0.3), scale * bandBoost)
        batch.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s))
        batch.root.setXY(n, x, z)
        batch.rot.setXY(n, Math.cos(yaw), Math.sin(yaw))
        batch.inv.setX(n, 1 / Math.max(1e-4, scale * bandBoost))
        n++
      }
    }
    batch.mesh.count = n
    batch.mesh.instanceMatrix.needsUpdate = true
    batch.root.needsUpdate = true
    batch.rot.needsUpdate = true
    batch.inv.needsUpdate = true
  }

  dispose(): void {
    for (const b of this.batches) {
      b.mesh.dispose()
      if (b.mesh.geometry !== this.geometry) b.mesh.geometry.dispose()
    }
    this.geometry.dispose()
  }
}

