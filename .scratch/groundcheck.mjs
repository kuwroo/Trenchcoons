// Verifies groundAt against a raycast on the REAL PlaneGeometry the game draws.
// Replicates rng.ts + greybox.ts heightAt exactly (same seed 'trenchcoons',
// same fork order: rng.fork('terrain') is the FIRST draw from the root stream).
import * as THREE from 'three'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashSeed(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
class Rng {
  constructor(seed) { this.next = mulberry32(typeof seed === 'string' ? hashSeed(seed) : seed) }
  float() { return this.next() }
  fork(tag) { return new Rng(hashSeed(tag + ':' + this.next())) }
}

const GROUND_HALF = 4000, GROUND_SEGMENTS = 420, CURVE_RADIUS = 400_000
const LAGOON = { x: -900, z: -1420, r: 640, depth: 128 }

function makeValueNoise(rng) {
  const N = 256
  const table = new Float32Array(N * N)
  for (let i = 0; i < table.length; i++) table[i] = rng.float() * 2 - 1
  const at = (ix, iy) => table[(((iy % N) + N) % N) * N + (((ix % N) + N) % N)] ?? 0
  const fade = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y)
    const tx = fade(x - xi), ty = fade(y - yi)
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx
    return a * (1 - ty) + b * ty
  }
}

const noise = makeValueNoise(new Rng('trenchcoons').fork('terrain'))
const baseHeight = (x, z) => {
  let h = 0
  h += noise(x / 380, z / 380) * 150
  h += noise(x / 150 + 13.5, z / 150 - 7.25) * 55
  h += noise(x / 88 - 41.0, z / 88 + 22.5) * 17
  h += noise(x / 46 + 91.5, z / 46 - 63.0) * 5
  return h - (x * x + z * z) / (2 * CURVE_RADIUS)
}
const bowl = (x, z) => {
  const d = Math.hypot(x - LAGOON.x, z - LAGOON.z) / LAGOON.r
  if (d >= 1) return 0
  const t = 1 - d
  return t * t * (3 - 2 * t)
}
const heightAt = (x, z) => baseHeight(x, z) - bowl(x, z) * LAGOON.depth
// The geometry stores vertex Y as float32, so the DRAWN lattice heights are the
// f32-rounded ones. Rounding here isolates our interpolation error from f32.
const heightAt32 = (x, z) => Math.fround(heightAt(x, z))

const GRID = (GROUND_HALF * 2) / GROUND_SEGMENTS

// OLD (bilinear)
const oldGroundAt = (x, z) => {
  const fx = (x + GROUND_HALF) / GRID, fz = (z + GROUND_HALF) / GRID
  const i = Math.floor(fx), j = Math.floor(fz)
  const tx = fx - i, tz = fz - j
  const x0 = i * GRID - GROUND_HALF, z0 = j * GRID - GROUND_HALF
  const h00 = heightAt(x0, z0), h10 = heightAt(x0 + GRID, z0)
  const h01 = heightAt(x0, z0 + GRID), h11 = heightAt(x0 + GRID, z0 + GRID)
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
}

// NEW (triangle-exact) — copied verbatim from greybox.ts
const newGroundAt = (x, z, h = heightAt, f = (v) => v) => {
  const fx = (x + GROUND_HALF) / GRID, fz = (z + GROUND_HALF) / GRID
  const i = Math.floor(fx), j = Math.floor(fz)
  const x0 = f(i * GRID - GROUND_HALF), z0 = f(j * GRID - GROUND_HALF)
  const x1 = f((i + 1) * GRID - GROUND_HALF), z1 = f((j + 1) * GRID - GROUND_HALF)
  const tx = (x - x0) / (x1 - x0), tz = (z - z0) / (z1 - z0)
  if (tx + tz <= 1) {
    const h00 = h(x0, z0)
    return h00 + (h(x1, z0) - h00) * tx + (h(x0, z1) - h00) * tz
  }
  const h11 = h(x1, z1)
  return h11 + (h(x0, z1) - h11) * (1 - tx) + (h(x1, z0) - h11) * (1 - tz)
}

// Build the SAME geometry the game builds, but only around the region of
// interest (a full 421^2 plane raycasts far too slowly). A local patch with the
// identical lattice alignment gives identical triangles.
function patchMesh(cx, cz, quads) {
  const i0 = Math.floor((cx + GROUND_HALF) / GRID) - quads
  const j0 = Math.floor((cz + GROUND_HALF) / GRID) - quads
  const n = quads * 2 + 1
  const size = n * GRID
  const g = new THREE.PlaneGeometry(size, size, n, n)
  g.rotateX(-Math.PI / 2)
  // Place so that its lattice matches the world lattice exactly.
  const ox = i0 * GRID - GROUND_HALF + size * 0.5
  const oz = j0 * GRID - GROUND_HALF + size * 0.5
  g.translate(ox, 0, oz)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)))
  pos.needsUpdate = true
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
  m.updateMatrixWorld()
  return m
}

const SITES = [
  ['spawn FLAT  ', 600, 880],
  ['capture FLAT', 580, 816],
  ['spawn JUMP  ', -160, 1040],
  ['capture JUMP', -160, 1147],
  ['perf ground ', 280, 760],
]

const ray = new THREE.Raycaster()
const down = new THREE.Vector3(0, -1, 0)
let worstNew = 0, worstOld = 0, worstNewAt = null, worstOldAt = null, n = 0

for (const [label, cx, cz] of SITES) {
  const mesh = patchMesh(cx, cz, 4)
  let wn = 0, wo = 0
  // 32x32 sweep over a 4-quad neighbourhood, deliberately off-lattice.
  for (let a = 0; a < 32; a++) {
    for (let b = 0; b < 32; b++) {
      const x = cx + (a / 32 - 0.5) * GRID * 4 + 0.3137
      const z = cz + (b / 32 - 0.5) * GRID * 4 + 0.7191
      ray.set(new THREE.Vector3(x, 5000, z), down)
      const hit = ray.intersectObject(mesh, false)[0]
      if (!hit) continue
      n++
      const dn = Math.abs(newGroundAt(x, z, heightAt32, Math.fround) - hit.point.y)
      const dold = Math.abs(oldGroundAt(x, z) - hit.point.y)
      if (dn > wn) wn = dn
      if (dold > wo) wo = dold
      if (dn > worstNew) { worstNew = dn; worstNewAt = [x, z] }
      if (dold > worstOld) { worstOld = dold; worstOldAt = [x, z] }
    }
  }
  console.log(`${label}  (${cx},${cz})   bilinear err max ${wo.toFixed(4)} m   triangle err max ${wn.toExponential(2)} m`)
}

console.log(`\n${n} raycast samples`)
console.log(`WORST bilinear : ${worstOld.toFixed(4)} m at ${worstOldAt?.map((v) => v.toFixed(1))}`)
console.log(`WORST triangle : ${worstNew.toExponential(3)} m at ${worstNewAt?.map((v) => v.toFixed(1))}`)
console.log(worstNew < 1e-4 ? 'PASS — groundAt is the drawn surface' : 'FAIL')
