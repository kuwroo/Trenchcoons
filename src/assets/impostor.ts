// Distance stand-ins.
//
// The usual answer is an octahedral impostor: render the asset from N angles
// into an atlas and blend three views at runtime. That is the right technique
// and it is the wrong one for this build, because it needs a texture path and a
// second material, and the shared painterly material reads NO UVs at all — it
// works from `positionLocal` / `positionWorld` / `normalWorld`. Bolting a
// sampled albedo onto it would fork the one material ART_BIBLE §3 insists there
// only ever be one of.
//
// So the impostor is geometric: the asset's real silhouette, as two crossed
// cards, with normals splayed off the card plane so the 3-stop ramp lights it
// as a volume instead of as a flat plate. That is enough because of what
// carries distance in this art direction — ART_BIBLE §1, "atmospheric
// perspective... the single biggest lever". By the range an impostor swaps in,
// haze has eaten most of the chroma and all of the interior detail, and what
// survives is outline and one broad value. Outline and one broad value is
// exactly what this produces, for 8-16 triangles.
//
// Solid convex assets (rock, boulder, outcrop) do NOT use cards — a crossed
// card reads as a paper cutout the moment the sun is off-axis. They get a
// coarse closed solid instead, which is the same silhouette and shades
// correctly from every side. `coarseSolid` is the entry point for those.

import { MeshBuilder, normalize, type Vec3 } from './mesh'
import { hullOf, spreadDirections } from './hull'
import type * as THREE from 'three/webgpu'

/** Andrew's monotone chain, in a plane picked by dropping one axis. */
export function silhouette2D(
  points: readonly Vec3[], axis: 'xz' | 'xy' | 'zy',
): [number, number][] {
  const pick = (p: Vec3): [number, number] =>
    axis === 'xz' ? [p[0], p[2]] : axis === 'xy' ? [p[0], p[1]] : [p[2], p[1]]
  const pts = points.map(pick).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  if (pts.length < 3) return pts
  const cross2 = (
    o: [number, number], a: [number, number], b: [number, number],
  ): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src: [number, number][]): [number, number][] => {
    const h: [number, number][] = []
    for (const p of src) {
      while (h.length >= 2 && cross2(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return [...half(pts), ...half([...pts].reverse())]
}

/** Evenly-spaced subset of a convex outline. A subset of a hull is still convex. */
function decimate(
  outline: readonly [number, number][], max: number,
): [number, number][] {
  if (outline.length <= max) return [...outline]
  const out: [number, number][] = []
  for (let i = 0; i < max; i++) out.push(outline[Math.round((i * outline.length) / max)]!)
  return out
}

/**
 * Two crossed cards carrying the asset's real outline.
 *
 * @param splay 0 leaves the card normals flat (it will read as cardboard), 1
 *   points every vertex normal straight out from the vertical axis (it will
 *   read as a sphere). Foliage wants ~0.7: enough that the two cards do not
 *   flip value against each other as the sun crosses them, which is the tell
 *   that gives a billboard away.
 * @param maxPoints Cap on outline vertices per card. The raw silhouette hull of
 *   a bowed log runs to a dozen points and the impostor then cost MORE than the
 *   coarsest mesh rung it was supposed to replace, which makes it pointless.
 *   Seven is enough to keep a log a log and a conifer a triangle.
 */
export function crossCards(
  points: readonly Vec3[], splay = 0.7, maxPoints = 7,
): THREE.BufferGeometry {
  const b = new MeshBuilder()
  card(b, decimate(silhouette2D(points, 'xy'), maxPoints), 'xy', splay)
  card(b, decimate(silhouette2D(points, 'zy'), maxPoints), 'zy', splay)
  return b.build()
}

function card(
  b: MeshBuilder, outline: readonly [number, number][], axis: 'xy' | 'zy', splay: number,
): void {
  if (outline.length < 3) return
  const to3 = (p: [number, number]): Vec3 =>
    axis === 'xy' ? [p[0], p[1], 0] : [0, p[1], p[0]]
  const flat: Vec3 = axis === 'xy' ? [0, 0, 1] : [1, 0, 0]
  // Splayed normal: blend the card's own normal toward the horizontal direction
  // from the vertical axis out to this vertex. Vertices near the axis keep the
  // card normal, vertices at the edge lean outward, so the card shades like the
  // cross-section of a volume.
  const n = (p: Vec3, sign: number): Vec3 => {
    const radial: Vec3 = [p[0], 0, p[2]]
    const rl = Math.hypot(radial[0], radial[2])
    if (rl < 1e-6) return normalize([flat[0] * sign, 0.25, flat[2] * sign])
    return normalize([
      flat[0] * sign * (1 - splay) + (radial[0] / rl) * splay,
      0.25,
      flat[2] * sign * (1 - splay) + (radial[2] / rl) * splay,
    ])
  }
  const loop = outline.map(to3)
  // Both sides, because the material is single-sided and a card seen from
  // behind must not vanish.
  const a = loop[0]!
  for (let i = 1; i + 1 < loop.length; i++) {
    b.triN(a, n(a, 1), loop[i]!, n(loop[i]!, 1), loop[i + 1]!, n(loop[i + 1]!, 1))
    b.triN(a, n(a, -1), loop[i + 1]!, n(loop[i + 1]!, -1), loop[i]!, n(loop[i]!, -1))
  }
}

/**
 * One tapered card from the point cloud's bounds — the cheapest thing that can
 * still be an asset, at four triangles.
 *
 * For grass. A tuft's silhouette convex hull is a rounded blob and the hull is
 * not worth carrying: at the range a tuft goes to impostor it is a few pixels
 * of green, and a card built from bounds is indistinguishable from one built
 * from the outline while costing a third as much. Both windings, because the
 * material is single-sided.
 */
export function billboard(points: readonly Vec3[], taper = 0.45): THREE.BufferGeometry {
  let r = 0
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of points) {
    r = Math.max(r, Math.hypot(p[0], p[2]))
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
  }
  if (!Number.isFinite(y0) || r <= 0) y0 = 0
  const b = new MeshBuilder()
  const n0 = normalize([-1, 0.5, 0])
  const n1 = normalize([1, 0.5, 0])
  const a: Vec3 = [-r, y0, 0]
  const c: Vec3 = [r, y0, 0]
  const d: Vec3 = [r * taper, y1, 0]
  const e: Vec3 = [-r * taper, y1, 0]
  b.quadN(a, n0, c, n1, d, n1, e, n0)
  b.quadN(a, n0, e, n0, d, n1, c, n1)
  return b.build()
}

/**
 * The support hull at a reduced direction count: a closed, correctly-shading
 * solid with the asset's silhouette and roughly a dozen faces. The impostor for
 * rock, and the coarse rungs of every solid asset's LOD ladder.
 */
export function emitCoarse(b: MeshBuilder, points: readonly Vec3[], dirs = 10): void {
  hullOf(points, spreadDirections(dirs)).emit(b)
}

export function coarseSolid(points: readonly Vec3[], dirs = 10): THREE.BufferGeometry {
  const b = new MeshBuilder()
  emitCoarse(b, points, dirs)
  return b.build()
}

/**
 * The coarsest solid that is STRICTLY cheaper than `maxTriangles`, by walking
 * the support-direction count down.
 *
 * A support hull's triangle count is not a function of its direction count
 * alone — how many directions actually bite depends on the cloud — so picking a
 * fixed number and hoping produced ladders where the last rung cost MORE than
 * the one before it (outcrop-shelf 56 -> 60). Searching makes the ladder
 * monotone by construction, which is the invariant `budget.ts` now enforces.
 */
export function coarseUnder(
  points: readonly Vec3[], maxTriangles: number, startDirs = 12,
): THREE.BufferGeometry {
  let fallback: THREE.BufferGeometry | null = null
  for (let dirs = startDirs; dirs >= 4; dirs--) {
    const geo = coarseSolid(points, dirs)
    const tris = (geo.index?.count ?? 0) / 3
    if (tris < maxTriangles) {
      fallback?.dispose()
      return geo
    }
    fallback?.dispose()
    fallback = geo
  }
  return fallback ?? coarseSolid(points, 4)
}
