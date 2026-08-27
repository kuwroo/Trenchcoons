// Convex polytopes by half-space intersection.
//
// This is the single most important file in the scatter library, because it is
// what produces the form ART_BIBLE §1 names as the most characteristic thing in
// refs/genshin/grasslands.jpg: "clear flat sculptural rock planes".
//
// The obvious way to make a rock is to displace an icosphere by noise. That is
// what the greybox does and it is exactly wrong — it produces a lumpy blob
// whose every triangle has a slightly different normal, so the painterly 3-stop
// ramp smears across it and the silhouette is a potato. The reference's rocks
// are the opposite: a small number of BIG FLAT PLANES meeting at hard edges,
// with the light landing as one value per plane.
//
// So a rock here is built the way a real fractured rock is: take a block and
// cut it with planes. Intersecting half-spaces is closed under the operation —
// the result is always convex, always closed, always watertight, and every face
// is exactly planar by construction. Three things fall out for free:
//
//   * flat facets with exact normals, which is the whole look;
//   * a COLLISION PROXY at zero extra cost, because the solid IS its own convex
//     hull — the world team can hand the vertex set straight to Rapier;
//   * a cheap LOD ladder, because dropping cut planes is a valid simplification
//     that can only ever make the solid bigger, never punch a hole in it.
//
// Nothing here uses floating-point-fragile connectivity: faces are independent
// polygons and the cap of a cut is rebuilt by chaining the cut segments, so a
// near-degenerate cut loses a sliver rather than corrupting the topology.

import { MeshBuilder, cross, dot, length, loopNormal, normalize, sub, type Vec3 } from './mesh'

export interface Plane {
  /** Unit outward normal. */
  n: Vec3
  /** Offset: the plane is `dot(n, p) = d`, and the solid keeps `dot(n, p) <= d`. */
  d: number
}

interface Face {
  plane: Plane
  loop: Vec3[]
}

const EPS = 1e-7

/** A closed convex solid, as the intersection of its faces' half-spaces. */
export class Polytope {
  private constructor(private faces: Face[]) {}

  /** The starting block. Every rock in the library begins as one of these. */
  static box(hx: number, hy: number, hz: number): Polytope {
    const mk = (n: Vec3, d: number, loop: Vec3[]): Face => ({ plane: { n, d }, loop })
    return new Polytope([
      mk([1, 0, 0], hx, [[hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz], [hx, -hy, -hz]]),
      mk([-1, 0, 0], hx, [[-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, hz]]),
      mk([0, 1, 0], hy, [[-hx, hy, hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz]]),
      mk([0, -1, 0], hy, [[-hx, -hy, -hz], [-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz]]),
      mk([0, 0, 1], hz, [[-hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz], [hx, -hy, hz]]),
      mk([0, 0, -1], hz, [[hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, -hz]]),
    ])
  }

  clone(): Polytope {
    return new Polytope(this.faces.map((f) => ({
      plane: { n: f.plane.n, d: f.plane.d },
      loop: f.loop.map((p) => [p[0], p[1], p[2]] as Vec3),
    })))
  }

  get faceCount(): number { return this.faces.length }

  /**
   * Cut with a half-space, keeping `dot(n, p) <= d`. No-op when the plane misses
   * the solid, and a no-op is what a distant cut plane SHOULD be — the caller
   * scatters planes without knowing which will bite.
   */
  clip(plane: Plane): this {
    const n = normalize(plane.n)
    const d = plane.d
    const kept: Face[] = []
    // Every face that gets cut contributes one segment to the boundary of the
    // new cap face. Collected as loose segments and chained afterwards, because
    // face-to-face adjacency is not tracked (and tracking it is exactly the
    // fragile part of a boolean).
    const segs: [Vec3, Vec3][] = []
    let cutAnything = false

    for (const f of this.faces) {
      const out: Vec3[] = []
      const enter: Vec3[] = []
      const m = f.loop.length
      let anyIn = false
      let anyOut = false
      for (let i = 0; i < m; i++) {
        const a = f.loop[i]!
        const b = f.loop[(i + 1) % m]!
        const da = dot(n, a) - d
        const db = dot(n, b) - d
        if (da <= EPS) { out.push(a); anyIn = true } else { anyOut = true }
        if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
          const t = da / (da - db)
          const p: Vec3 = [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
          ]
          out.push(p)
          enter.push(p)
        }
      }
      if (!anyIn) { cutAnything = true; continue }
      if (!anyOut) { kept.push(f); continue }
      cutAnything = true
      if (out.length >= 3) kept.push({ plane: f.plane, loop: out })
      if (enter.length === 2) segs.push([enter[0]!, enter[1]!])
    }

    if (!cutAnything) return this
    if (kept.length === 0) { this.faces = []; return this }

    const cap = chainLoop(segs)
    if (cap.length >= 3) {
      // Orient the cap so it faces out along the cut normal, like every other
      // face. A cap wound the wrong way is a hole in the shadow pass.
      const ln = loopNormal(cap)
      const loop = ln && dot(ln, n) < 0 ? [...cap].reverse() : cap
      kept.push({ plane: { n, d }, loop })
    }
    this.faces = kept
    return this
  }

  /** Every distinct corner of the solid. This is the collision hull. */
  points(): Vec3[] {
    const seen = new Set<string>()
    const out: Vec3[] = []
    for (const f of this.faces) {
      for (const p of f.loop) {
        const k = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(p)
      }
    }
    return out
  }

  bounds(): { min: Vec3; max: Vec3 } {
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity
    let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity
    for (const p of this.points()) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); z0 = Math.min(z0, p[2])
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); z1 = Math.max(z1, p[2])
    }
    if (!Number.isFinite(x0)) return { min: [0, 0, 0], max: [0, 0, 0] }
    return { min: [x0, y0, z0], max: [x1, y1, z1] }
  }

  /**
   * Push every face out along its own normal by `amount`, WITHOUT moving the
   * vertices — i.e. re-cut the original block with the offset planes. Used to
   * grow a collision proxy a few centimetres proud of the render mesh so the
   * kart never visually penetrates before it collides.
   */
  offsetPlanes(amount: number): Polytope {
    const b = this.bounds()
    const hx = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])) + amount * 2 + 1
    const hy = Math.max(Math.abs(b.min[1]), Math.abs(b.max[1])) + amount * 2 + 1
    const hz = Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])) + amount * 2 + 1
    const out = Polytope.box(hx, hy, hz)
    for (const f of this.faces) out.clip({ n: f.plane.n, d: f.plane.d + amount })
    return out
  }

  /** Emit the solid, one flat facet per face. */
  emit(b: MeshBuilder, transform?: (p: Vec3) => Vec3): void {
    for (const f of this.faces) {
      const loop = transform ? f.loop.map(transform) : f.loop
      // With a transform the stored plane normal is no longer right, so let the
      // builder recompute it from the (still planar, if the transform is
      // affine) loop.
      b.polygon(loop, transform ? undefined : f.plane.n)
    }
  }

  /** Faces sorted largest-first. The LOD ladder drops the small ones. */
  faceAreas(): number[] {
    return this.faces.map((f) => polygonArea(f.loop))
  }
}

function polygonArea(loop: readonly Vec3[]): number {
  let ax = 0; let ay = 0; let az = 0
  const a = loop[0]!
  for (let i = 1; i + 1 < loop.length; i++) {
    const c = cross(sub(loop[i]!, a), sub(loop[i + 1]!, a))
    ax += c[0]; ay += c[1]; az += c[2]
  }
  return Math.hypot(ax, ay, az) * 0.5
}

/**
 * Chain loose segments into one closed loop.
 *
 * Greedy nearest-endpoint matching with a generous tolerance. The segments come
 * from cutting a convex solid so there is exactly one loop and it is convex;
 * the tolerance exists because the same corner is computed independently on the
 * two faces that share it and the two answers differ in the last bits.
 */
function chainLoop(segs: readonly [Vec3, Vec3][]): Vec3[] {
  if (segs.length < 3) return []
  const tol = 1e-5
  const used = new Array<boolean>(segs.length).fill(false)
  const first = segs[0]!
  used[0] = true
  const loop: Vec3[] = [first[0], first[1]]
  for (let step = 1; step < segs.length; step++) {
    const tail = loop[loop.length - 1]!
    let best = -1
    let bestFlip = false
    let bestDist = tol
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue
      const s = segs[i]!
      const d0 = length(sub(s[0], tail))
      const d1 = length(sub(s[1], tail))
      if (d0 < bestDist) { bestDist = d0; best = i; bestFlip = false }
      if (d1 < bestDist) { bestDist = d1; best = i; bestFlip = true }
    }
    if (best < 0) break
    used[best] = true
    const s = segs[best]!
    loop.push(bestFlip ? s[0] : s[1])
  }
  // The last point closes back onto the first; drop it.
  if (loop.length > 3 && length(sub(loop[loop.length - 1]!, loop[0]!)) < tol) loop.pop()
  return loop.length >= 3 ? loop : []
}

/**
 * A deterministic, roughly uniform set of directions on the sphere — the
 * icosahedron's 12 vertices plus its 20 face centres.
 *
 * Used as the support-direction set for `hullOf`. 32 directions is the sweet
 * spot: enough that the proxy hugs a rock within a few centimetres, few enough
 * that Rapier's convex-hull cost stays flat.
 */
export const HULL_DIRECTIONS: readonly Vec3[] = buildDirections()

function buildDirections(): Vec3[] {
  const t = (1 + Math.sqrt(5)) / 2
  const verts: Vec3[] = []
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      verts.push([0, s1 * 1, s2 * t], [s1 * 1, s2 * t, 0], [s1 * t, 0, s2 * 1])
    }
  }
  const v = verts.map(normalize)
  const out: Vec3[] = [...v]
  // Face centres: every triple of vertices that are mutual nearest neighbours.
  const edge = 2 / Math.sqrt(1 + t * t) + 1e-6
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      if (length(sub(v[i]!, v[j]!)) > edge) continue
      for (let k = j + 1; k < v.length; k++) {
        if (length(sub(v[i]!, v[k]!)) > edge) continue
        if (length(sub(v[j]!, v[k]!)) > edge) continue
        out.push(normalize([
          v[i]![0] + v[j]![0] + v[k]![0],
          v[i]![1] + v[j]![1] + v[k]![1],
          v[i]![2] + v[j]![2] + v[k]![2],
        ]))
      }
    }
  }
  return out
}

/**
 * Convex proxy of an arbitrary point cloud, by support mapping.
 *
 * Not an exact hull, and deliberately so. An exact quickhull on a 900-vertex
 * shrub returns a 300-face solid that no physics engine wants; this returns at
 * most `dirs.length` faces and it OVER-approximates, which is the correct
 * direction of error for a collision proxy — the kart stops a couple of
 * centimetres early rather than sinking into the rock before it notices.
 */
export function hullOf(
  points: readonly Vec3[], dirs: readonly Vec3[] = HULL_DIRECTIONS, inflate = 0,
): Polytope {
  if (points.length === 0) return Polytope.box(0.01, 0.01, 0.01)
  let hx = 0; let hy = 0; let hz = 0
  for (const p of points) {
    hx = Math.max(hx, Math.abs(p[0]))
    hy = Math.max(hy, Math.abs(p[1]))
    hz = Math.max(hz, Math.abs(p[2]))
  }
  const solid = Polytope.box(hx + inflate + 1e-3, hy + inflate + 1e-3, hz + inflate + 1e-3)
  for (const dir of dirs) {
    let d = -Infinity
    for (const p of points) d = Math.max(d, dot(dir, p))
    solid.clip({ n: dir, d: d + inflate })
  }
  return solid
}
