// M1 greybox world.
//
// MILESTONES: "Atmosphere before terrain. A greybox world under correct
// atmosphere already reads like the references." So this is deliberately dumb
// geometry — rolling ground, faceted rocks, cone conifers, a cliff mass, and a
// distant ridge line whose only job is to give the aerial perspective something
// to eat. M2 replaces all of it with the CDLOD terrain.
//
// Everything here is seeded. No Math.random, ever (CLAUDE.md invariant).
// Everything except the ground is instanced, because the budget is <1500 draw
// calls and 400 conifers as individual meshes would spend a third of it on the
// greybox.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { PainterlyMaterial } from '../material/painterly'
import { surface } from '../material/defs'
import type { Rng } from '../core/rng'

/** Half-extent of the ground plane, metres. */
const GROUND_HALF = 4000
const GROUND_SEGMENTS = 420
/**
 * Fake planetary curvature. Makes the ground fall away below eye level at
 * ~3.1km instead of ending in a straight seam against the sky.
 */
const CURVE_RADIUS = 400_000

/**
 * A lagoon, cut deterministically into the heightfield.
 *
 * Not decoration. Every round-1 frame was "one green hue plus a pale sky", and
 * that is most of why measured saturation sat under the references: the master
 * palette's turquoise, cream and lavender existed as presets but nothing in the
 * world exercised them. cliffs-tohad.jpg gets its chroma from a saturated COOL
 * mass sitting next to the lime. So does this.
 */
const LAGOON = { x: -900, z: -1420, r: 640, depth: 128 }

/** Seeded value noise on a wrapped 256x256 table. Deterministic, cheap. */
function makeValueNoise(rng: Rng): (x: number, y: number) => number {
  const N = 256
  const table = new Float32Array(N * N)
  for (let i = 0; i < table.length; i++) table[i] = rng.float() * 2 - 1
  const at = (ix: number, iy: number): number =>
    table[(((iy % N) + N) % N) * N + (((ix % N) + N) % N)] ?? 0
  const fade = (t: number): number => t * t * (3 - 2 * t)
  return (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const tx = fade(x - xi)
    const ty = fade(y - yi)
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx
    return a * (1 - ty) + b * ty
  }
}

/** Collects transforms, then bakes one InstancedMesh. */
class InstanceSet {
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private readonly list: THREE.Matrix4[] = []

  push(
    pos: THREE.Vector3, scale: THREE.Vector3,
    rx = 0, ry = 0, rz = 0,
  ): void {
    this.e.set(rx, ry, rz)
    this.q.setFromEuler(this.e)
    this.list.push(this.m.compose(pos, this.q, scale).clone())
  }

  bake(
    geometry: THREE.BufferGeometry, material: THREE.Material, name: string,
  ): THREE.InstancedMesh | null {
    if (this.list.length === 0) return null
    const mesh = new THREE.InstancedMesh(geometry, material, this.list.length)
    for (let i = 0; i < this.list.length; i++) mesh.setMatrixAt(i, this.list[i]!)
    mesh.instanceMatrix.needsUpdate = true
    mesh.name = name
    // The greybox is a fixed set of landmarks; frustum culling the whole batch
    // would pop it out as soon as the origin instance leaves the view.
    mesh.frustumCulled = false
    return mesh
  }
}

export interface Greybox {
  group: THREE.Group
  heightAt: (x: number, z: number) => number
  materials: PainterlyMaterial[]
}

export function buildGreybox(atmosphere: Atmosphere, rng: Rng): Greybox {
  const group = new THREE.Group()
  group.name = 'greybox'
  const noise = makeValueNoise(rng.fork('terrain'))

  // Big shapes, restrained detail (ART_BIBLE §2). The amplitude/cell ratio is
  // what sets slope, and slope is what the 3-stop ramp reads — too gentle and
  // the whole terrain sits on one stop.
  const baseHeight = (x: number, z: number): number => {
    let h = 0
    h += noise(x / 380, z / 380) * 150
    h += noise(x / 150 + 13.5, z / 150 - 7.25) * 55
    h += noise(x / 88 - 41.0, z / 88 + 22.5) * 17
    h += noise(x / 46 + 91.5, z / 46 - 63.0) * 5
    return h - (x * x + z * z) / (2 * CURVE_RADIUS)
  }

  /** Smooth 0..1 bowl, 1 at the lagoon centre. */
  const bowl = (x: number, z: number): number => {
    const d = Math.hypot(x - LAGOON.x, z - LAGOON.z) / LAGOON.r
    if (d >= 1) return 0
    const t = 1 - d
    return t * t * (3 - 2 * t)
  }

  const heightAt = (x: number, z: number): number =>
    baseHeight(x, z) - bowl(x, z) * LAGOON.depth

  // Partly filled, so a rim of shore shows all the way round.
  const waterLevel = baseHeight(LAGOON.x, LAGOON.z) - LAGOON.depth * 0.46

  const materials: PainterlyMaterial[] = []
  /** Every surface comes from a JSON def in assets/defs/surfaces. */
  const mat = (defId: string): THREE.MeshBasicNodeMaterial => {
    const m = new PainterlyMaterial(atmosphere, surface(defId))
    materials.push(m)
    return m.material
  }

  const meadow = mat('meadow')
  const water = mat('water')
  const flowers = mat('flowers')
  const rock = mat('rock')
  const cliff = mat('cliff')
  const foliage = mat('foliage')
  // The frame's dark anchor. See assets/defs/surfaces/bush.json.
  const bush = mat('bush')
  const bark = mat('bark')
  const sand = mat('sand')

  // ── ground ────────────────────────────────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(
    GROUND_HALF * 2, GROUND_HALF * 2, GROUND_SEGMENTS, GROUND_SEGMENTS,
  )
  groundGeo.rotateX(-Math.PI / 2) // rotate the GEOMETRY: local +Y stays up, so
                                  // the material's vertical gradient still works
  const pos = groundGeo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)))
  }
  groundGeo.computeVertexNormals()
  const ground = new THREE.Mesh(groundGeo, meadow)
  ground.name = 'ground'
  ground.frustumCulled = false
  group.add(ground)

  // ── shared geometry ───────────────────────────────────────────────────────
  const rockGeo = new THREE.IcosahedronGeometry(1, 0)
  const tierGeo = new THREE.ConeGeometry(1, 1, 9, 1)
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1, 6)
  const cliffGeo = new THREE.CylinderGeometry(1, 1.18, 1, 7, 1)
  const bushGeo = new THREE.IcosahedronGeometry(1, 1)
  const ridgeGeo = new THREE.ConeGeometry(1, 1, 11, 1)

  const p = new THREE.Vector3()
  const sc = new THREE.Vector3()

  // ── conifers ──────────────────────────────────────────────────────────────
  const tiers = new InstanceSet()
  const trunks = new InstanceSet()
  const trees = rng.fork('trees')
  // Anything scattered below the waterline would float or drown; the lagoon
  // has to be a hole in every scatter set, not just in the heightfield.
  const dry = (x: number, z: number): boolean => heightAt(x, z) > waterLevel + 2
  for (let i = 0; i < 420; i++) {
    const a = trees.range(0, Math.PI * 2)
    const r = 12 + Math.sqrt(trees.float()) * 1400
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (!dry(x, z)) continue
    const y = heightAt(x, z) - 0.4
    const h = trees.range(11, 27)
    const w = h * trees.range(0.2, 0.3)
    const spin = trees.range(0, Math.PI * 2)

    trunks.push(p.set(x, y + h * 0.21, z), sc.set(w * 0.55, h * 0.42, w * 0.55), 0, spin, 0)
    const n = trees.int(3, 4)
    for (let t = 0; t < n; t++) {
      const f = t / n
      const th = h * (0.46 - f * 0.1)
      const tw = w * (1 - f * 0.6)
      tiers.push(
        p.set(x, y + h * (0.3 + f * 0.52) + th * 0.5, z),
        sc.set(tw, th, tw), 0, spin + trees.range(0, Math.PI), 0,
      )
    }
  }

  // ── rocks and bushes ──────────────────────────────────────────────────────
  const rocks = new InstanceSet()
  const bushes = new InstanceSet()
  const blooms = new InstanceSet()
  const scatter = rng.fork('scatter')
  for (let i = 0; i < 320; i++) {
    const a = scatter.range(0, Math.PI * 2)
    const r = 8 + Math.sqrt(scatter.float()) * 1500
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (!dry(x, z)) continue
    const s = scatter.range(1.6, 9)
    rocks.push(
      p.set(x, heightAt(x, z) - s * 0.28, z),
      sc.set(s * scatter.range(0.9, 1.7), s * scatter.range(0.5, 0.95), s * scatter.range(0.9, 1.7)),
      scatter.range(-0.28, 0.28), scatter.range(0, 6.28), scatter.range(-0.28, 0.28),
    )
  }
  for (let i = 0; i < 620; i++) {
    const a = scatter.range(0, Math.PI * 2)
    const r = 6 + Math.sqrt(scatter.float()) * 1100
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (!dry(x, z)) continue
    // Roughly a quarter of the understory flowers. This is the master palette's
    // lavender, and without it every frame is one green hue plus a sky.
    const isBloom = scatter.float() < 0.24
    // Bush clumps are much larger than the flower ones. They are the frame's
    // only authored dark mass, and at the round-2 size (1.1-4.2 m) they covered
    // well under a percent of any shot — which is why p05 of value sat at 0.62
    // against 0.48 in the references. cliffs-tohad.jpg gives its near hedges
    // real area; so does this.
    const s = isBloom ? scatter.range(1.2, 4.0) : scatter.range(4.0, 13.0)
    const set = isBloom ? blooms : bushes
    // Clumps, not dots. A single ellipsoid at this size is a pebble; three
    // overlapping ones read as one mass with a broken silhouette, which is what
    // the near hedges in cliffs-tohad.jpg actually are — and area is the whole
    // point of the dark anchor.
    const lobes = isBloom ? 1 : 3
    for (let k = 0; k < lobes; k++) {
      const j = k === 0 ? 0 : s * 0.85
      const ja = scatter.range(0, 6.28)
      const ls = s * (k === 0 ? 1 : scatter.range(0.55, 0.85))
      set.push(
        p.set(x + Math.cos(ja) * j, heightAt(x, z) - ls * 0.42, z + Math.sin(ja) * j),
        sc.set(ls * 1.45, ls * 0.85, ls * 1.45), 0, scatter.range(0, 6.28), 0,
      )
    }
  }

  // ── a cliff mass, for the cream/lavender half of the palette ───────────────
  const cliffSet = new InstanceSet()
  const cliffs = rng.fork('cliffs')
  for (let i = 0; i < 22; i++) {
    const a = cliffs.range(-1.0, 0.6) + Math.PI * 1.32
    const r = cliffs.range(420, 900)
    const h = cliffs.range(46, 128)
    const w = cliffs.range(28, 74)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    cliffSet.push(
      p.set(x, heightAt(x, z) + h * 0.3, z),
      sc.set(w, h, w * cliffs.range(0.7, 1.3)), 0, cliffs.range(0, 6.28), 0,
    )
  }

  // ── distant ridge: the aerial-perspective test target ──────────────────────
  const ridgeSet = new InstanceSet()
  const ridge = rng.fork('ridge')
  for (let i = 0; i < 90; i++) {
    const a = ridge.range(0, Math.PI * 2)
    const r = ridge.range(2500, 3800)
    const h = ridge.range(160, 380)
    const w = h * ridge.range(1.0, 2.0)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    ridgeSet.push(
      p.set(x, heightAt(x, z) + h * 0.3, z),
      sc.set(w, h, w * ridge.range(0.7, 1.4)), 0, ridge.range(0, 6.28), 0,
    )
  }

  for (const m of [
    tiers.bake(tierGeo, foliage, 'conifer-tiers'),
    trunks.bake(trunkGeo, bark, 'conifer-trunks'),
    rocks.bake(rockGeo, rock, 'rocks'),
    bushes.bake(bushGeo, bush, 'bushes'),
    blooms.bake(bushGeo, flowers, 'flowers'),
    cliffSet.bake(cliffGeo, cliff, 'cliffs'),
    ridgeSet.bake(ridgeGeo, rock, 'ridge'),
  ]) if (m) group.add(m)

  // ── lagoon: turquoise water over a cream shore ─────────────────────────────
  // Two discs, the sand one slightly wider and slightly lower, so a shore rim
  // reads all the way round without needing a splat map (that is M2's job).
  const shore = new THREE.Mesh(new THREE.CylinderGeometry(LAGOON.r * 0.86, LAGOON.r * 0.62, 6, 48), sand)
  shore.position.set(LAGOON.x, waterLevel - 3.4, LAGOON.z)
  shore.frustumCulled = false
  shore.name = 'lagoon-shore'
  group.add(shore)

  const lagoon = new THREE.Mesh(new THREE.CylinderGeometry(LAGOON.r * 0.7, LAGOON.r * 0.55, 5, 48), water)
  lagoon.position.set(LAGOON.x, waterLevel, LAGOON.z)
  lagoon.frustumCulled = false
  lagoon.name = 'lagoon'
  group.add(lagoon)

  // ── sand shelf, so one warm value sits in frame ────────────────────────────
  const shelf = new THREE.Mesh(new THREE.CylinderGeometry(150, 190, 8, 26), sand)
  shelf.position.set(-260, heightAt(-260, -380) - 2, -380)
  shelf.frustumCulled = false
  group.add(shelf)

  return { group, heightAt, materials }
}
