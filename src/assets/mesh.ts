// Mesh construction primitives shared by every asset generator.
//
// Two rules come out of the rest of the codebase and both are load-bearing here:
//
//   1. NO `three/addons`. The addons import from `three`, not `three/webgpu`,
//      which pulls a second copy of the core library into the bundle and gives
//      us two incompatible `BufferGeometry` classes. See the header of
//      src/vehicle/geometry.ts — the same rule, the same reason.
//   2. ONE GEOMETRY PER BATCH. Everything an asset is made of is merged down
//      into as few geometries as there are distinct surfaces on it, because the
//      scene is drawn once for the frame and once per shadow cascade, so a draw
//      call is worth five against the <1500 budget.
//
// `MeshBuilder` is the workhorse. Generators push triangles, quads and polygons
// at it and it produces ONE indexed, welded, flat-shaded geometry. Flat shading
// is the default and that is deliberate: ART_BIBLE §1 asks for "clear flat
// sculptural rock planes", and the painterly 3-stop ramp reads a face with a
// single exact normal as a single flat stop — which is precisely the Genshin
// rock look. Smooth normals are opt-in per triangle (`triN`/`quadN`), used only
// where a form genuinely is a smooth volume (grass blades, bark).

import * as THREE from 'three/webgpu'

export type Vec3 = readonly [number, number, number]

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z]

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
export function addv(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a)
  return l < 1e-12 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Rotate about +Y. Used constantly — every radial form here is built by it. */
export function rotY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]
}

/**
 * Accumulates triangles, then welds and indexes them once.
 *
 * Welding matters more than it looks: a generator that emits a rock as a
 * triangle soup produces three vertices per triangle, and the vertex buffer of
 * an INSTANCED mesh is paid once but read per instance per cascade. Welding on
 * (position, normal) keeps facet boundaries hard — two faces meeting at an edge
 * have different normals and therefore stay split — while collapsing the
 * duplicates inside a single flat face, which is where all the waste is.
 */
export class MeshBuilder {
  private readonly pos: number[] = []
  private readonly nrm: number[] = []
  private readonly idx: number[] = []
  private readonly seen = new Map<string, number>()

  get triangles(): number { return this.idx.length / 3 }
  get vertices(): number { return this.pos.length / 3 }

  private vertex(p: Vec3, n: Vec3): number {
    // 1e-4 m on position, 1e-3 on the (unit) normal. Coarser than float
    // precision on purpose: generators compute the same corner by two different
    // routes all the time and the last bits will not agree.
    const key =
      `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}|` +
      `${Math.round(n[0] * 1e3)},${Math.round(n[1] * 1e3)},${Math.round(n[2] * 1e3)}`
    const hit = this.seen.get(key)
    if (hit !== undefined) return hit
    const i = this.pos.length / 3
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    this.seen.set(key, i)
    return i
  }

  /** Flat triangle. Winding is counter-clockwise when seen from the front. */
  tri(a: Vec3, b: Vec3, c: Vec3, normal?: Vec3): void {
    const n = normal ?? faceNormal(a, b, c)
    // A degenerate triangle contributes nothing but still costs an index and a
    // draw; generators clip and taper, so they produce them.
    if (n === null) return
    this.idx.push(this.vertex(a, n), this.vertex(b, n), this.vertex(c, n))
  }

  /** Triangle with authored per-vertex normals. */
  triN(a: Vec3, na: Vec3, b: Vec3, nb: Vec3, c: Vec3, nc: Vec3): void {
    this.idx.push(this.vertex(a, na), this.vertex(b, nb), this.vertex(c, nc))
  }

  /** Flat quad, wound a-b-c-d. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal?: Vec3): void {
    const n = normal ?? faceNormal(a, b, c) ?? faceNormal(a, c, d)
    if (n === null) return
    this.tri(a, b, c, n)
    this.tri(a, c, d, n)
  }

  quadN(a: Vec3, na: Vec3, b: Vec3, nb: Vec3, c: Vec3, nc: Vec3, d: Vec3, nd: Vec3): void {
    this.triN(a, na, b, nb, c, nc)
    this.triN(a, na, c, nc, d, nd)
  }

  /** Convex polygon as a fan. The normal is taken from the whole loop. */
  polygon(loop: readonly Vec3[], normal?: Vec3): void {
    if (loop.length < 3) return
    const n = normal ?? loopNormal(loop)
    if (n === null) return
    const a = loop[0]!
    for (let i = 1; i + 1 < loop.length; i++) this.tri(a, loop[i]!, loop[i + 1]!, n)
  }

  /** The same polygon wound the other way, i.e. facing the other side. */
  polygonFlipped(loop: readonly Vec3[], normal?: Vec3): void {
    const rev = [...loop].reverse()
    this.polygon(rev, normal ? scale(normal, -1) : undefined)
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    const idx = this.vertices > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx)
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    return geo
  }
}

/** Null when the three points are collinear, i.e. the face has no area. */
export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const n = cross(sub(b, a), sub(c, a))
  const l = length(n)
  return l < 1e-12 ? null : [n[0] / l, n[1] / l, n[2] / l]
}

/**
 * Newell's method over a whole loop, rather than the first three points.
 *
 * The three-point shortcut fails on exactly the polygons this file produces:
 * a plane-clipped facet often has two nearly-coincident vertices where the cut
 * grazed a corner, and picking those as the first three gives a normal that is
 * numerical noise. Newell weights every edge, so a single degenerate corner
 * cannot decide the answer.
 */
export function loopNormal(loop: readonly Vec3[]): Vec3 | null {
  let nx = 0
  let ny = 0
  let nz = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!
    const q = loop[(i + 1) % loop.length]!
    nx += (p[1] - q[1]) * (p[2] + q[2])
    ny += (p[2] - q[2]) * (p[0] + q[0])
    nz += (p[0] - q[0]) * (p[1] + q[1])
  }
  const l = Math.hypot(nx, ny, nz)
  return l < 1e-12 ? null : [nx / l, ny / l, nz / l]
}

/**
 * Loft a stack of rings into a tube. Every ring must have the same point count.
 *
 * This is how conifers, logs, stumps, roots, the box tub and every tapered form
 * in the library are built. `flat` gives each quad its own exact normal, which
 * is what makes a nine-sided trunk read as nine facets under the 3-stop ramp
 * rather than as a soft cylinder.
 *
 * WINDING CONVENTION, and it is not optional: rings run FROM the bottom of the
 * form TO the top, and each ring is wound counter-clockwise about the axis of
 * travel (`ring` and `roundedRect` both do this). Then the side faces point
 * OUTWARD, `capEnd` closes the top facing +axis and `capStart` closes the
 * bottom facing -axis. Reverse the ring ORDER to get an inward-facing surface,
 * which is what a shell's liner wants.
 *
 * The first version wound the side quads the other way, so a stack authored
 * bottom-to-top came out inside-out while its caps — which were already written
 * to this convention — did not. Nothing errors when that happens: the near face
 * is culled and you see the far interior instead, which reads as a form that is
 * mysteriously dark and hollow rather than as a bug. It cost the conifers a
 * whole capture round.
 */
export function loft(
  b: MeshBuilder,
  rings: readonly (readonly Vec3[])[],
  opts: { closed?: boolean; capStart?: boolean; capEnd?: boolean; flat?: boolean } = {},
): void {
  const closed = opts.closed ?? true
  const flat = opts.flat ?? true
  for (let r = 0; r + 1 < rings.length; r++) {
    const lo = rings[r]!
    const hi = rings[r + 1]!
    const n = Math.min(lo.length, hi.length)
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n
      const a = lo[i]!
      const bb = lo[j]!
      const c = hi[j]!
      const d = hi[i]!
      if (flat) {
        b.quad(a, d, c, bb)
      } else {
        // Radial normals about the ring centroid: a smooth tube.
        const ca = ringCentroid(lo)
        const cb = ringCentroid(hi)
        b.quadN(
          a, radial(a, ca), d, radial(d, cb), c, radial(c, cb), bb, radial(bb, ca),
        )
      }
    }
  }
  const first = rings[0]
  const final = rings[rings.length - 1]
  if (opts.capStart && first) b.polygonFlipped(first)
  if (opts.capEnd && final) b.polygon(final)
}

function ringCentroid(ring: readonly Vec3[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (const p of ring) { x += p[0]; y += p[1]; z += p[2] }
  const k = 1 / Math.max(1, ring.length)
  return [x * k, y * k, z * k]
}

function radial(p: Vec3, c: Vec3): Vec3 {
  const d: Vec3 = [p[0] - c[0], 0, p[2] - c[2]]
  return length(d) < 1e-9 ? [0, 1, 0] : normalize(d)
}

/** A closed ring of `n` points on a circle of radius `r` at height `y`. */
export function ring(n: number, r: number, y: number, phase = 0, cx = 0, cz = 0): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    out.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r])
  }
  return out
}

/**
 * A closed rounded-rectangle ring in the XZ plane at height `y`.
 *
 * Wound counter-clockwise in XZ (theta increasing), which is the winding the
 * rest of this file assumes: `loft([top, bottom])` then faces OUTWARD, and
 * `polygon(loop)` on such a ring faces +Y. Reverse the ring order for the
 * inside of a shell.
 */
export function roundedRect(
  hx: number, hz: number, r: number, y: number, cornerSegs = 3,
): Vec3[] {
  const rr = Math.max(0, Math.min(r, hx, hz))
  const ix = hx - rr
  const iz = hz - rr
  const out: Vec3[] = []
  const corners: [number, number][] = [[ix, iz], [-ix, iz], [-ix, -iz], [ix, -iz]]
  for (let c = 0; c < 4; c++) {
    const [cx, cz] = corners[c]!
    const a0 = c * Math.PI * 0.5
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * Math.PI * 0.5
      out.push([cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr])
    }
  }
  return out
}

/** Apply a matrix-free TRS to a ring, in place-free style. */
export function transformRing(
  r: readonly Vec3[], dx: number, dy: number, dz: number, yaw = 0, sx = 1, sz = 1,
): Vec3[] {
  return r.map((p) => {
    const q = rotY([p[0] * sx, p[1], p[2] * sz], yaw)
    return [q[0] + dx, q[1] + dy, q[2] + dz] as Vec3
  })
}

/**
 * Merge indexed geometries carrying position and normal into one.
 *
 * The implementation src/vehicle/geometry.ts has always had, lifted here so the
 * kart and the scatter library share one merge instead of two that drift.
 * Position and normal are the only attributes the painterly material reads (it
 * works from `positionLocal` / `positionWorld` / `normalWorld`, never from a
 * UV), so everything else is dropped on purpose rather than carried dead.
 *
 * @param requireIndexed Throw on a non-indexed part rather than indexing it.
 *   The kart's callers rely on this: an unindexed part there means a geometry
 *   was built by a route that was not meant to reach the merge.
 */
export function mergeParts(
  parts: readonly THREE.BufferGeometry[],
  opts: { requireIndexed?: boolean; dispose?: boolean } = {},
): THREE.BufferGeometry {
  const dispose = opts.dispose ?? true
  let vertices = 0
  let indices = 0
  for (const p of parts) {
    const pos = p.getAttribute('position')
    if (!pos) throw new Error('mergeParts: part has no position attribute')
    if (!p.index) {
      if (opts.requireIndexed) throw new Error('mergeParts: part is not indexed')
      indices += pos.count
    } else {
      indices += p.index.count
    }
    vertices += pos.count
  }
  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  let v = 0
  let i = 0
  for (const p of parts) {
    const pos = p.getAttribute('position')!
    const nrm = p.getAttribute('normal')
    const idx = p.index
    for (let k = 0; k < pos.count; k++) {
      position[(v + k) * 3] = pos.getX(k)
      position[(v + k) * 3 + 1] = pos.getY(k)
      position[(v + k) * 3 + 2] = pos.getZ(k)
      if (nrm) {
        normal[(v + k) * 3] = nrm.getX(k)
        normal[(v + k) * 3 + 1] = nrm.getY(k)
        normal[(v + k) * 3 + 2] = nrm.getZ(k)
      }
    }
    if (idx) {
      for (let k = 0; k < idx.count; k++) index[i + k] = v + idx.getX(k)
      i += idx.count
    } else {
      for (let k = 0; k < pos.count; k++) index[i + k] = v + k
      i += pos.count
    }
    v += pos.count
    if (dispose) p.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(position, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  out.computeBoundingSphere()
  out.computeBoundingBox()
  return out
}

const _mat = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _eul = new THREE.Euler(0, 0, 0, 'YXZ')
const _vec = new THREE.Vector3()
const _scl = new THREE.Vector3(1, 1, 1)

/** Position a geometry in its parent's space, in place. */
export function placeGeometry(
  geo: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  _eul.set(rx, ry, rz)
  _quat.setFromEuler(_eul)
  geo.applyMatrix4(_mat.compose(_vec.set(x, y, z), _quat, _scl.set(sx, sy, sz)))
  return geo
}

export function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.index
  if (idx) return idx.count / 3
  return (geo.getAttribute('position')?.count ?? 0) / 3
}

/** Every position in a geometry, as flat xyz triples. For hulls and bounds. */
export function positionsOf(geo: THREE.BufferGeometry): Float32Array {
  const pos = geo.getAttribute('position')
  if (!pos) return new Float32Array(0)
  const out = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i)
    out[i * 3 + 1] = pos.getY(i)
    out[i * 3 + 2] = pos.getZ(i)
  }
  return out
}
