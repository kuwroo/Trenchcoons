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

/**
 * Footprint of a scattered form, for anything that needs to know where the
 * world is already occupied.
 *
 * Added for M3. The greybox scatters bushes up to 13 m across and rocks up to
 * 9 m, and the first chase-camera capture spawned the car inside one: the shot
 * was four fifths dark bush with two raccoon ears over the top, and nothing in
 * the harness could tell that from a lighting bug. A spawn point is only
 * reproducible if "is this spot clear" is answerable, and the scatter is the
 * only thing that knows.
 *
 * Circles in the XZ plane, world space. M4's deform stamping and M5's prop
 * collision want the same list.
 */
export interface Obstacle {
  x: number
  z: number
  /** Horizontal radius, metres. */
  r: number
}

export interface Greybox {
  group: THREE.Group
  /** The analytic heightfield. What the ground MESH was sampled from. */
  heightAt: (x: number, z: number) => number
  /**
   * The height of the ground you can actually see, i.e. of the rendered
   * triangles rather than of the function they were sampled from.
   *
   * These differ by metres and anything that has to sit ON the ground must use
   * this one. The ground plane is 420 segments over 8 km, so a quad is 19 m
   * across, while the heightfield's finest octave has a 46 m wavelength: linear
   * interpolation across a quad departs from the analytic surface by up to
   * ~4 m in the middle. M3's first landing capture showed the kart buried to
   * its rim in a hillside for exactly this reason — the suspension was resting
   * perfectly on a surface that was not being drawn.
   *
   * Exact, not approximate. Bilinear over the same lattice was the first
   * attempt and it is still wrong, because a quad is not a bilinear patch — it
   * is TWO TRIANGLES, and the two only agree when the quad has no twist.
   * Sampling the twist term `h00 + h11 - h10 - h01` around the M3 spawns gives
   * a bilinear-vs-triangle disagreement of up to 1.69 m, against a 0.4 m wheel
   * radius: two wheel diameters of buried or hovering, i.e. exactly the failure
   * the function was added to remove, just less often. This one interpolates on
   * the real triangulation, so the residual is identically zero everywhere.
   * M2's CDLOD terrain replaces both.
   */
  groundAt: (x: number, z: number) => number
  /** Surface of the lagoon, world Y. Anything below this is underwater. */
  waterLevel: number
  /**
   * Nearest point to (x, z) that a vehicle can legitimately be put down on:
   * dry, not inside a scattered form, and gentle enough that the car will not
   * spawn pinned against its own roll clamp.
   *
   * Added because nothing validated a spawn and both perf scenes proved it —
   * `pos=280,14,760` put the kart at groundAt = -83.8, i.e. 84 m down inside
   * the lagoon bowl with the chase camera in the pit beside it, and the vista
   * scene parked it at 28.6 degrees of roll wedged between two hillsides. Both
   * runs then reported a healthy 60 fps for a picture of nothing.
   */
  spawnPoint: (x: number, z: number) => [number, number]
  materials: PainterlyMaterial[]
  /** Every scattered form big enough to hide a car. */
  obstacles: Obstacle[]
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

  // Lattice of the ground mesh below. Must stay in step with the geometry.
  const GRID = (GROUND_HALF * 2) / GROUND_SEGMENTS
  /**
   * Height of the DRAWN triangle under (x, z).
   *
   * `PlaneGeometry` emits, per quad (ix, iy), the index pairs (a, b, d) and
   * (b, c, d) where a = (ix, iy), b = (ix, iy+1), c = (ix+1, iy+1) and
   * d = (ix+1, iy). After the `rotateX(-PI/2)` below, iy maps to +z, so in the
   * quad-local coordinates (tx along +x, tz along +z) those two triangles are
   *
   *   lower: h00, h01, h10   — the half with tx + tz <= 1
   *   upper: h01, h11, h10   — the half with tx + tz >= 1
   *
   * Each is planar, so the interpolant is affine in (tx, tz) and the barycentric
   * weights collapse to the two differences below. Verified against a
   * `THREE.Raycaster` fired at the real ground mesh: over 5120 off-lattice
   * samples around both car spawns, both capture points and the perf spawn,
   * bilinear disagrees with the drawn triangle by up to 1.68 m and this by
   * 1.8e-5 m — which is float32 vertex storage, not interpolation. Against
   * float64 lattice coordinates the residual is 1.2e-12 m.
   */
  const groundAt = (x: number, z: number): number => {
    const fx = (x + GROUND_HALF) / GRID
    const fz = (z + GROUND_HALF) / GRID
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const tx = fx - i
    const tz = fz - j
    const x0 = i * GRID - GROUND_HALF
    const z0 = j * GRID - GROUND_HALF
    const x1 = x0 + GRID
    const z1 = z0 + GRID
    if (tx + tz <= 1) {
      // Lower triangle: origin at h00, edges toward h10 (+x) and h01 (+z).
      const h00 = heightAt(x0, z0)
      return h00
        + (heightAt(x1, z0) - h00) * tx
        + (heightAt(x0, z1) - h00) * tz
    }
    // Upper triangle: origin at h11, edges toward h01 (-x) and h10 (-z).
    const h11 = heightAt(x1, z1)
    return h11
      + (heightAt(x0, z1) - h11) * (1 - tx)
      + (heightAt(x1, z0) - h11) * (1 - tz)
  }

  // Partly filled, so a rim of shore shows all the way round.
  const waterLevel = baseHeight(LAGOON.x, LAGOON.z) - LAGOON.depth * 0.46

  const materials: PainterlyMaterial[] = []
  const obstacles: Obstacle[] = []
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
  // Mountains had no material of their own at all — the distant ridge was
  // drawn with the same `rock` def as the pebbles at the player's feet, so a
  // 380 m peak got a preset authored for a 3 m boulder and read as a flat
  // untextured cone. ART_BIBLE 4 wants exposed rock reading DARK against a
  // pale summit; `mountain` authors that, with a tall vertical gradient so the
  // cap catches the light and the base sinks into the haze.
  const mountain = mat('mountain')
  const tuft = mat('scrub')

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
  for (let i = 0; i < 620; i++) {
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
    obstacles.push({ x, z, r: w })
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
  for (let i = 0; i < 520; i++) {
    const a = scatter.range(0, Math.PI * 2)
    const r = 8 + Math.sqrt(scatter.float()) * 1500
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (!dry(x, z)) continue
    const s = scatter.range(1.6, 9)
    obstacles.push({ x, z, r: s * 1.7 })
    rocks.push(
      p.set(x, heightAt(x, z) - s * 0.28, z),
      sc.set(s * scatter.range(0.9, 1.7), s * scatter.range(0.5, 0.95), s * scatter.range(0.9, 1.7)),
      scatter.range(-0.28, 0.28), scatter.range(0, 6.28), scatter.range(-0.28, 0.28),
    )
  }
  for (let i = 0; i < 440; i++) {
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
    obstacles.push({ x, z, r: s * (isBloom ? 1.45 : 2.6) })
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

  // ── scrub tufts: the small-form layer every reference has and we did not ───
  //
  // refs/painterly/desert-hazy.jpeg is the most instructive shot on the board
  // for this: its SAND is almost perfectly smooth, and it still measures the
  // highest local detail of any reference (medStd 0.0799, zero dead-flat tiles).
  // All of that comes from small dark forms — scrub, sticks, rock shards —
  // scattered densely through the near and middle distance. cliffs-tohad does
  // the same with hedges and flower clumps. Surface brushwork alone cannot
  // substitute for it, and it has one property no shading trick has: a
  // silhouette reads at EVERY hour, so it holds a frame together at a horizon
  // sun exactly as well as at noon.
  //
  // Small, dense, and biased toward the camera-visible band rather than spread
  // evenly to the horizon, so the near field gets real texture without turning
  // the vista into soup.
  const tufts = new InstanceSet()
  const tuftRng = rng.fork('tufts')
  for (let i = 0; i < 1200; i++) {
    const a = tuftRng.range(0, Math.PI * 2)
    // Two overlapping bands: a dense inner ring and a thinner reach outward.
    const inner = tuftRng.float() < 0.62
    const r = inner
      ? 6 + Math.sqrt(tuftRng.float()) * 620
      : 300 + Math.sqrt(tuftRng.float()) * 1700
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (!dry(x, z)) continue
    const s = tuftRng.range(1.1, 3.4)
    tufts.push(
      p.set(x, heightAt(x, z) - s * 0.5, z),
      sc.set(s * tuftRng.range(0.85, 1.3), s * tuftRng.range(0.75, 1.15), s * tuftRng.range(0.85, 1.3)),
      0, tuftRng.range(0, 6.28), 0,
    )
  }
  // Offset copy of the ground camera's neighbourhood: the shot list puts two
  // cameras at (280, ., 760) and one at (100, ., -560), and a scatter centred on
  // the world origin leaves both of them standing in a thin patch.
  for (const [cx, cz] of [[280, 760], [100, -560]] as const) {
    for (let i = 0; i < 1050; i++) {
      const a = tuftRng.range(0, Math.PI * 2)
      const r = 4 + Math.sqrt(tuftRng.float()) * 520
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      if (!dry(x, z)) continue
      const s = tuftRng.range(1.0, 3.0)
      tufts.push(
        p.set(x, heightAt(x, z) - s * 0.5, z),
        sc.set(s * tuftRng.range(0.85, 1.3), s * tuftRng.range(0.75, 1.15), s * tuftRng.range(0.85, 1.3)),
        0, tuftRng.range(0, 6.28), 0,
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
    obstacles.push({ x, z, r: w * 1.2 })
    cliffSet.push(
      p.set(x, heightAt(x, z) + h * 0.3, z),
      sc.set(w, h, w * cliffs.range(0.7, 1.3)), 0, cliffs.range(0, 6.28), 0,
    )
  }

  // ── distant ridge: the aerial-perspective test target ──────────────────────
  const ridgeSet = new InstanceSet()
  const ridge = rng.fork('ridge')
  for (let i = 0; i < 130; i++) {
    const a = ridge.range(0, Math.PI * 2)
    const r = ridge.range(2400, 3800)
    const h = ridge.range(160, 380)
    const w = h * ridge.range(1.0, 2.0)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    ridgeSet.push(
      p.set(x, heightAt(x, z) + h * 0.3, z),
      sc.set(w, h, w * ridge.range(0.7, 1.4)), 0, ridge.range(0, 6.28), 0,
    )
    // Shoulders. A single cone is a triangle; three overlapping cones of
    // different heights read as a massif, which is what gives the Genshin and
    // desert references a broken skyline instead of a row of pyramids.
    const spurs = ridge.int(2, 3)
    for (let k = 0; k < spurs; k++) {
      const sa = ridge.range(0, 6.28)
      const sd = w * ridge.range(0.4, 0.85)
      const sh = h * ridge.range(0.42, 0.78)
      const sw = sh * ridge.range(0.9, 1.7)
      const sx = x + Math.cos(sa) * sd
      const sz = z + Math.sin(sa) * sd
      ridgeSet.push(
        p.set(sx, heightAt(sx, sz) + sh * 0.3, sz),
        sc.set(sw, sh, sw * ridge.range(0.7, 1.4)), 0, ridge.range(0, 6.28), 0,
      )
    }
  }

  for (const m of [
    tiers.bake(tierGeo, foliage, 'conifer-tiers'),
    trunks.bake(trunkGeo, bark, 'conifer-trunks'),
    rocks.bake(rockGeo, rock, 'rocks'),
    bushes.bake(bushGeo, bush, 'bushes'),
    blooms.bake(bushGeo, flowers, 'flowers'),
    cliffSet.bake(cliffGeo, cliff, 'cliffs'),
    ridgeSet.bake(ridgeGeo, mountain, 'ridge'),
    tufts.bake(bushGeo, tuft, 'tufts'),
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

  // ── spawn validation ───────────────────────────────────────────────────────
  // Deliberately built AFTER the scatter, so `obstacles` is complete. Draws no
  // RNG, so the seeded stream is untouched and every existing capture is
  // bit-identical.
  const SPAWN = {
    /** Clearance above the waterline. A kart is 0.74 m to the axle line. */
    freeboard: 2.5,
    /**
     * Steepest ground a spawn may sit on, radians.
     *
     * 0.16 (9 deg), not the 0.5 the pose clamp allows: a spawn is where the
     * PARKED captures happen, and the first validated spawn still put the idle
     * kart at 13.4 degrees of static roll, which photographs as a car abandoned
     * on a hillside rather than as a car at rest.
     */
    maxSlope: 0.16,
    /** Extra room around a scattered form, metres. Half a kart plus a margin. */
    margin: 3.5,
    /** Search rings, metres. Beyond ~120 m a "spawn here" request is a typo. */
    rings: [0, 9, 18, 30, 45, 64, 88, 120],
    perRing: 16,
  } as const

  /**
   * Worst tilt the kart's plane fit can report here, for ANY heading, radians.
   *
   * Two earlier versions were both too generous. Max over +/-x and +/-z lets a
   * purely diagonal slope through at sqrt(2) times the threshold; a central
   * -difference gradient then under-reports whenever the footprint straddles a
   * triangle edge, and it does, because the ground quads are 19 m and the kart
   * is 2.7 m. Both accepted a spawn the vehicle then sat on at 12.6 deg.
   *
   * A ring of the kart's own half-diagonal bounds it directly: the plane fit is
   * an average of contact heights, so no heading can produce more tilt than the
   * extreme pair on that ring.
   */
  const FOOTPRINT = 1.35
  const slopeAt = (x: number, z: number): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const h = groundAt(x + Math.cos(a) * FOOTPRINT, z + Math.sin(a) * FOOTPRINT)
      if (h < lo) lo = h
      if (h > hi) hi = h
    }
    return Math.atan((hi - lo) / (2 * FOOTPRINT))
  }

  const clearOfScatter = (x: number, z: number): boolean => {
    for (const o of obstacles) {
      const rr = o.r + SPAWN.margin
      const dx = x - o.x
      const dz = z - o.z
      if (dx * dx + dz * dz < rr * rr) return false
    }
    return true
  }

  const spawnPoint = (x: number, z: number): [number, number] => {
    // Scored so that a world with no perfect answer still gets the least bad
    // one rather than the caller's drowned original.
    let best: [number, number] = [x, z]
    let bestScore = -Infinity
    for (const r of SPAWN.rings) {
      const n = r === 0 ? 1 : SPAWN.perRing
      for (let i = 0; i < n; i++) {
        // Fixed angles, no RNG: the same request must always answer the same.
        const a = (i / n) * Math.PI * 2 + r * 0.37
        const px = x + Math.cos(a) * r
        const pz = z + Math.sin(a) * r
        // Water is a DISC, not a global plane. Testing `groundAt < waterLevel`
        // everywhere rejected a perfectly dry meadow 1.5 km from the lagoon
        // whose only crime was sitting below the lagoon's surface height.
        const inLagoon = Math.hypot(px - LAGOON.x, pz - LAGOON.z) < LAGOON.r
        const depth = inLagoon
          ? groundAt(px, pz) - (waterLevel + SPAWN.freeboard)
          : 1
        const slope = slopeAt(px, pz)
        const clear = clearOfScatter(px, pz)
        if (depth > 0 && slope < SPAWN.maxSlope && clear) return [px, pz]
        const score = Math.min(depth, 0) * 3
          - Math.max(0, slope - SPAWN.maxSlope) * 40
          - (clear ? 0 : 25) - r * 0.02
        if (score > bestScore) { bestScore = score; best = [px, pz] }
      }
    }
    return best
  }

  // ── sand shelf, so one warm value sits in frame ────────────────────────────
  const shelf = new THREE.Mesh(new THREE.CylinderGeometry(150, 190, 8, 26), sand)
  shelf.position.set(-260, heightAt(-260, -380) - 2, -380)
  shelf.frustumCulled = false
  group.add(shelf)

  return { group, heightAt, groundAt, waterLevel, spawnPoint, materials, obstacles }
}
