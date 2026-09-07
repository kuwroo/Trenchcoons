// Instanced silhouette grass — overgrown-portfolio GrassField placement,
// on Trenchcoons WebGPU / painterly / global WindField.
//
// OVERGROWN CONTRACT (see /Users/chloeongsiyi/overgrown-portfolio/src/grass/):
//   • Uniform density across a streaming window — NOT denser near the camera
//     with thinned outer rings (the old BAND_THIN annular system is gone).
//   • Near + far LOD pools cover the SAME area. Far = larger cards on a
//     coarser grid + shader distance fade; it is fill at range, not a density
//     falloff by camera radius.
//   • Path clear + slope mask + olive silhouette carpet.
//
// Lighting stays painterly + Atmosphere. Wind stays the one global WindField.

import * as THREE from 'three/webgpu'
import {
  attribute, cameraPosition, float, length, positionGeometry, positionLocal,
  positionWorld, pow, saturate, sin, smoothstep, texture, uniform, uv, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { spatialHash } from '../core/spatialHash'
import { PainterlyMaterial, type DeformHook } from '../material/painterly'
import { surface } from '../material/defs'
import type { TerrainWorld } from '../terrain/world'
import { biomeTint, graded } from './surfaceGrade'
import { createSilhouetteCrossGeometry } from '../vegetation/grass/silhouetteGeometry'
import { grassAlphaMap } from '../vegetation/grass/silhouetteTexture'

/** Streaming window diameter, metres — overgrown GrassField `size: 240`. */
const FIELD = 240
const HALF = FIELD * 0.5

/**
 * Overgrown `defaults.density` (1.45) × rebuild's 1.15 factor.
 * Biome `grassAt.density` still scales locally (meadow high, forest low, desert 0).
 */
const DENSITY_SCALE = 1.45 * 1.15

/** Overgrown World.ts after setLodDistances(32, 68). */
const LOD_NEAR = 32
const LOD_FAR = 68

/** Overgrown bladeWidth / bladeHeight. */
const CLUMP_W = 1.35
const CLUMP_H = 1.05

/** Overgrown rebuild scaleMin / scaleMax. */
const SCALE_MIN = 0.95
const SCALE_SPAN = 0.60

/**
 * Caps. Overgrown runs 56k–110k on a fixed 240 m pad; we stream the same
 * window around the player so the ceiling sits in that band.
 */
const NEAR_CAP = 82000
const FAR_CAP = 18000

/** Far grid is coarser — overgrown `chunkStep = gridStep * 2.2`. */
const FAR_CELL_MUL = 2.2
/** Overgrown far accept: `if (random() > 0.88) continue`. */
const FAR_KEEP = 0.88

const SWAY = 0.11
/** Overgrown slopeMask: nrm.y < 0.38 rejected → slope ~0.925. Use roughSlope. */
const MAX_SLOPE = 0.72
const PLAYER_RADIUS = 1.2
const PUSH = 0.55
const FLATTEN = 0.32
/** Overgrown GRASS_ROOT_SINK + ground bias. */
const ROOT_SINK = 0.06

interface Batch {
  mesh: THREE.InstancedMesh
  root: THREE.InstancedBufferAttribute
  rot: THREE.InstancedBufferAttribute
  inv: THREE.InstancedBufferAttribute
  cap: number
  /** 0 = near (fade out with distance), 1 = far (fade in then out). */
  lodFar: boolean
}

interface GrassCand {
  d2: number
  x: number
  y: number
  z: number
  yaw: number
  sx: number
  sy: number
  sz: number
  inv: number
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
  private dirty = true
  private nextPass = 0
  private readonly kartPos = uniform(new THREE.Vector2(0, 0))
  private readonly kartOn = uniform(0)
  private readonly nearGeo: THREE.BufferGeometry
  private readonly farGeo: THREE.BufferGeometry
  private readonly alphaMap: THREE.Texture
  private readonly worldSeed: number
  private readonly cands: GrassCand[] = []
  private readonly candPool: GrassCand[] = []

  constructor(
    atmosphere: Atmosphere,
    private readonly world: TerrainWorld,
    private readonly wind: WindField,
    private readonly deform: DeformHook | null = null,
  ) {
    this.worldSeed = world.seed
    this.group.name = 'grass'
    this.nearGeo = createSilhouetteCrossGeometry(CLUMP_W, CLUMP_H)
    this.farGeo = createSilhouetteCrossGeometry(CLUMP_W * 1.25, CLUMP_H * 1.1)
    this.alphaMap = grassAlphaMap()

    this.batches.push(this.makeBatch(atmosphere, this.nearGeo, NEAR_CAP, false, 'grass-near'))
    this.batches.push(this.makeBatch(atmosphere, this.farGeo, FAR_CAP, true, 'grass-far'))
  }

  private makeBatch(
    atmosphere: Atmosphere,
    geometry: THREE.BufferGeometry,
    cap: number,
    lodFar: boolean,
    name: string,
  ): Batch {
    const material = this.buildMaterial(atmosphere, lodFar)
    const mesh = new THREE.InstancedMesh(geometry, material, cap)
    mesh.name = name
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = true
    const root = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
    const rot = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
    const inv = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1)
    for (const a of [root, rot, inv]) a.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('iRoot', root)
    geometry.setAttribute('iRot', rot)
    geometry.setAttribute('iInv', inv)
    this.group.add(mesh)
    return { mesh, root, rot, inv, cap, lodFar }
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

  private buildMaterial(atmosphere: Atmosphere, isFarLod: boolean): THREE.Material {
    const params = graded('grassMound', surface('grassMound'))
    const root = vec2(attribute<'vec2'>('iRoot', 'vec2'))
    const phase = root.x.mul(12.9898).add(root.y.mul(78.233)).sin().mul(43758.5453).fract().mul(6.2831853)
    const stiff = root.x.mul(39.346).add(root.y.mul(11.135)).sin().mul(43758.5453).fract().mul(0.16).add(0.92)

    const tint = biomeTint(texture(this.world.litMap, this.mapUv(root)).rgb, 0xa8b86a, 0.9)
    const pm = new PainterlyMaterial(atmosphere, params, null, { tint })
    this.materials.push(pm)

    const mat = pm.material
    mat.side = THREE.DoubleSide
    // Node materials do NOT auto-wire `.alphaMap` once `opacityNode` is set —
    // the LOD fade below replaces the whole opacity chain, so assigning
    // `mat.alphaMap` alone left every card a solid green rectangle. Sample the
    // silhouette explicitly and multiply it in (see opacityNode below).
    mat.alphaTest = 0.12
    mat.transparent = true

    const h = saturate(uv().y)
    const hBend = h.mul(h).mul(float(1.15).sub(h.mul(0.15)))
    const h2 = h.mul(h)

    // Synced field wind — same wave math as overgrown / prior port.
    const wdir = this.wind.dirNode
    const along = root.x.mul(wdir.x).add(root.y.mul(wdir.y))
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
    const windOffset = vec3(
      wdir.x.mul(windAmt).mul(hBend).mul(SWAY),
      windAmt.mul(hBend).mul(SWAY).mul(-0.16),
      wdir.y.mul(windAmt).mul(hBend).mul(SWAY),
    )

    const toBlade = root.sub(this.kartPos)
    const distPush = toBlade.length()
    const influence = float(1).sub(smoothstep(float(0), float(PLAYER_RADIUS), distPush))
      .mul(this.kartOn)
    const influence2 = influence.mul(influence)
    const pushDir = toBlade.div(distPush.max(1e-4))
    const pushOffset = vec3(
      pushDir.x.mul(influence2).mul(h2).mul(PUSH),
      influence2.mul(h).mul(FLATTEN).mul(float(CLUMP_H)).negate(),
      pushDir.y.mul(influence2).mul(h2).mul(PUSH),
    )

    const crushSample = this.deform
      ? this.deform.shade(vec3(root.x, float(0), root.y))
      : { mask: float(0), slope: vec2(0, 0) }
    const crush = saturate(crushSample.mask).mul(0.94)
    const crushW = pow(saturate(positionGeometry.y.div(float(CLUMP_H))), float(1.7))
    const crushOffset = vec3(
      crushSample.slope.x.clamp(-1, 1).negate().mul(crush).mul(crushW).mul(0.5),
      positionGeometry.y.negate().mul(crush).mul(crushW),
      crushSample.slope.y.clamp(-1, 1).negate().mul(crush).mul(crushW).mul(0.5),
    )

    mat.positionNode = positionLocal.add(windOffset).add(pushOffset).add(crushOffset)

    // Overgrown LOD fade: near fades out with distance; far fades in then out.
    // Same window for both — NOT a density ring.
    const cam = cameraPosition
    const dx = positionWorld.x.sub(cam.x)
    const dz = positionWorld.z.sub(cam.z)
    const dist = length(vec2(dx, dz))
    const nearD = float(LOD_NEAR)
    const farD = float(LOD_FAR)
    let visibility: Node<'float'>
    if (isFarLod) {
      const fadeIn = smoothstep(nearD.mul(0.7), nearD.add(farD.sub(nearD).mul(0.15)), dist)
      const fadeOut = float(1).sub(smoothstep(farD, farD.mul(1.35), dist))
      visibility = fadeIn.mul(fadeOut)
    } else {
      visibility = float(1).sub(smoothstep(nearD, farD.max(nearD.add(0.01)), dist))
    }
    // Cutout × LOD. `grass-clump.png` is white-on-transparent; `.a` is the mask.
    // `alphaTest` then discards the soft fringe so cards do not sort as smoke.
    const cutout = texture(this.alphaMap, uv()).a
    mat.opacityNode = visibility.mul(cutout)

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
    const moved = !(Math.abs(cx - this.lastX) < 8 && Math.abs(cz - this.lastZ) < 8)
    if (force || !Number.isFinite(this.lastX)) {
      this.lastX = cx
      this.lastZ = cz
      this.rebuild(0, cx, cz)
      this.rebuild(1, cx, cz)
      this.dirty = false
      this.nextPass = 0
      return
    }
    if (moved) {
      this.lastX = cx
      this.lastZ = cz
      this.rebuild(0, cx, cz)
      this.nextPass = 1
      this.dirty = true
      return
    }
    if (!this.dirty) return
    this.rebuild(this.nextPass, cx, cz)
    this.nextPass = (this.nextPass + 1) % 2
    if (this.nextPass === 0) this.dirty = false
  }

  private h(ix: number, iz: number, channel: number): number {
    return spatialHash(ix, iz, channel, this.worldSeed)
  }

  private takeCand(): GrassCand {
    const c = this.candPool.pop()
    if (c) return c
    return { d2: 0, x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1, inv: 1 }
  }

  /**
   * Place one LOD pool over the full FIELD window at uniform density.
   * `pass` 0 = near, 1 = far (coarser grid, larger cards) — same coverage.
   */
  private rebuild(pass: number, cx: number, cz: number): void {
    const batch = this.batches[pass]!
    const far = batch.lodFar
    const outer2 = HALF * HALF

    for (let n = 0; n < this.cands.length; n++) this.candPool.push(this.cands[n]!)
    this.cands.length = 0

    // Sample a representative density at the centre for lattice spacing so the
    // carpet is even (overgrown uses one gridStep for the whole field). Local
    // grassAt still gates each cell so desert/path stay clear.
    const g0 = this.world.grassAt(cx, cz)
    const baseDens = Math.max(0.55, (g0.density > 0 ? g0.density : 1) * DENSITY_SCALE)
    const gridStep = 1 / Math.sqrt(baseDens)
    const cell = far ? gridStep * FAR_CELL_MUL : gridStep
    const area = cell * cell

    const i0 = Math.floor((cx - HALF) / cell)
    const i1 = Math.ceil((cx + HALF) / cell)
    const j0 = Math.floor((cz - HALF) / cell)
    const j1 = Math.ceil((cz + HALF) / cell)

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const jx = this.h(i, j, 11)
        const jz = this.h(i, j, 23)
        const x = (i + jx) * cell
        const z = (j + jz) * cell
        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > outer2) continue

        const g = this.world.grassAt(x, z)
        if (!g.id || g.density <= 0) continue

        // Uniform accept — no distance thinning. Density = biome grassAt only.
        const dens = g.density * DENSITY_SCALE
        if (this.h(i, j, 41) > dens * area) continue
        if (far && this.h(i, j, 43) > FAR_KEEP) continue

        const y = this.world.heightAt(x, z)
        if (y < this.world.waterLevel + 0.4) continue
        if (this.world.roughSlopeAt(x, z, 0.9) > MAX_SLOPE) continue

        const yaw = this.h(i, j, 67) * Math.PI * 2
        const scale = g.scale * (SCALE_MIN + this.h(i, j, 89) * SCALE_SPAN)
        const boost = far ? 1.2 : 1
        const sx = scale * boost * (0.92 + this.h(i, j, 91) * 0.2)
        const sy = scale * boost * (0.85 + this.h(i, j, 97) * 0.3)
        const sz = sx
        const cand = this.takeCand()
        cand.d2 = d2
        cand.x = x
        cand.y = y - ROOT_SINK
        cand.z = z
        cand.yaw = yaw
        cand.sx = sx
        cand.sy = sy
        cand.sz = sz
        cand.inv = 1 / Math.max(1e-4, sx)
        this.cands.push(cand)
      }
    }

    // Prefer nearer instances when over cap (fill the view first), but the
    // lattice itself is still uniform density — this is only a budget clip.
    this.cands.sort((a, b) => a.d2 - b.d2)
    const keep = Math.min(batch.cap, this.cands.length)
    for (let n = 0; n < keep; n++) {
      const c = this.cands[n]!
      this.p.set(c.x, c.y, c.z)
      this.e.set(0, c.yaw, 0)
      this.q.setFromEuler(this.e)
      this.s.set(c.sx, c.sy, c.sz)
      batch.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s))
      batch.root.setXY(n, c.x, c.z)
      batch.rot.setXY(n, Math.cos(c.yaw), Math.sin(c.yaw))
      batch.inv.setX(n, c.inv)
    }
    batch.mesh.count = keep
    batch.mesh.instanceMatrix.needsUpdate = true
    batch.root.needsUpdate = true
    batch.rot.needsUpdate = true
    batch.inv.needsUpdate = true
  }

  dispose(): void {
    for (const b of this.batches) {
      b.mesh.dispose()
    }
    this.nearGeo.dispose()
    this.farGeo.dispose()
  }
}
