// Rock: the form the whole scatter set is judged on.
//
// refs/genshin/grasslands.jpg is more than half rock by area, and every piece
// of it is the same thing at a different scale — a block cut by a few big
// planes. Flat tops that catch the key as one value, vertical fracture faces
// that fall into one shadow value, hard edges between them, and no noise
// anywhere. The grass-level slabs in the foreground, the shelves in the middle
// distance and the peaks on the skyline are all that same solid.
//
// So this generator does not displace a sphere. It starts with a block and cuts
// it (see hull.ts for why that is the right primitive), with the cut planes
// drawn from two families that are visible by name in the reference:
//
//   BEDDING   near-horizontal planes. They make the flat tops and the stepped
//             shelves. The reference's rock is sedimentary and reads as stacked
//             layers; the tops are all very nearly parallel to each other.
//   FRACTURE  near-vertical planes. They make the faces that drop away from
//             those tops. In the reference these are the DARK shapes — a
//             vertical face never catches a high sun — and they are what gives
//             the rock its value contrast against the grass.
//
// The mix between them is the single most expressive parameter here. All
// bedding gives pancakes; all fracture gives a shard. The reference sits around
// 0.45, which is roughly one flat surface for every one and a bit walls.

import { Polytope, type Plane } from '../hull'
import { MeshBuilder, dot, normalize, type Vec3 } from '../mesh'
import { boundsFromPoints, hullShape, solidCollider } from '../collider'
import { defineGenerator, randomDirection, type GenContext, type RawAsset } from '../generator'
import { num, type Params } from '../schema'

const schema = {
  size: num(1.8, 0.15, 26, 'Longest horizontal dimension.', 'm'),
  height: num(0.62, 0.08, 2.6, 'Height as a fraction of `size`.'),
  aspect: num(0.82, 0.25, 1, 'Depth as a fraction of width. Below 1 the rock has a long axis.'),
  cuts: num(9, 0, 22, 'Fracture planes. Each one costs about three triangles.'),
  bedding: num(0.45, 0, 1, 'Share of cuts that are near-horizontal. 0 shard, 1 pancake.'),
  bite: num(0.2, 0.02, 0.55, 'Mean depth of a cut, as a fraction of the solid.'),
  tilt: num(0.16, 0, 0.7, 'How far the main top plane tilts off level.', 'rad'),
  embed: num(0.16, 0, 0.6, 'Fraction of the height that sits BELOW y=0, i.e. buried.'),
  jag: num(0.55, 0, 1, 'Spread of cut depths. 0 makes every cut the same size.'),
} as const

function support(points: readonly Vec3[], n: Vec3): number {
  let d = -Infinity
  for (const p of points) d = Math.max(d, dot(n, p))
  return d
}

function buildPlanes(p: Params<typeof schema>, ctx: GenContext): Plane[] {
  const rng = ctx.rng
  const planes: Plane[] = []
  // The top. Authored rather than sampled, because "there is one big flat
  // plane on top" is the read, and leaving it to chance loses it on a third of
  // the variants.
  const ta = rng.range(0, Math.PI * 2)
  planes.push({
    n: normalize([Math.cos(ta) * Math.sin(p.tilt), Math.cos(p.tilt), Math.sin(ta) * Math.sin(p.tilt)]),
    d: 0,
  })
  // Two base bevels, so the rock does not meet the ground on a hard rectangle
  // even where it is not buried.
  for (let i = 0; i < 2; i++) {
    const a = rng.range(0, Math.PI * 2)
    planes.push({ n: normalize([Math.cos(a) * 0.55, -0.83, Math.sin(a) * 0.55]), d: 0 })
  }
  const n = Math.round(p.cuts)
  for (let i = 0; i < n; i++) {
    // Alternating rather than random, so a small rock with three cuts still
    // gets one of each family instead of three of whichever the rng picked.
    const isBedding = ((i * 0.6180339887) % 1) < p.bedding
    planes.push({
      n: randomDirection(rng, isBedding ? -rng.range(0.45, 0.8) : rng.range(0.75, 0.95)),
      d: 0,
    })
  }
  return planes
}

function solidFrom(
  p: Params<typeof schema>, planes: readonly Plane[], count: number, depths: readonly number[],
): Polytope {
  const hx = p.size * 0.5
  const hz = p.size * 0.5 * p.aspect
  const hy = p.size * p.height * 0.5
  const solid = Polytope.box(hx, hy, hz)
  for (let i = 0; i < Math.min(count, planes.length); i++) {
    const pl = planes[i]!
    const pts = solid.points()
    if (pts.length === 0) break
    const s = support(pts, pl.n)
    // Cut in from the current support by `bite` of the solid's own extent in
    // that direction, so a late cut on an already-small solid takes a
    // proportional slice rather than removing the whole thing.
    let ext = Infinity
    for (const q of pts) ext = Math.min(ext, dot(pl.n, q))
    solid.clip({ n: pl.n, d: s - (s - ext) * (depths[i] ?? 0.2) })
  }
  return solid
}

export const rock = defineGenerator({
  info: {
    name: 'rock',
    slots: ['body'],
    defaultSurfaces: { body: 'rock' },
  },
  schema,
  generate(p, ctx): RawAsset {
    const planes = buildPlanes(p, ctx)
    // Depths drawn ONCE and shared across the ladder, so LOD1 is LOD0 with the
    // last cuts omitted rather than a differently-shaped rock. The silhouette
    // can then only grow as the ladder coarsens, which is the one direction of
    // LOD error the eye forgives.
    const depths = planes.map((_, i) =>
      i === 0
        ? p.bite * ctx.rng.range(0.6, 1.1)
        : p.bite * (1 - p.jag * 0.5 + ctx.rng.float() * p.jag),
    )
    const counts = [
      planes.length,
      Math.max(3, Math.round(planes.length * 0.55)),
      Math.max(3, Math.round(planes.length * 0.28)),
    ]
    const drop = p.size * p.height * p.embed
    const shift = (q: Vec3): Vec3 => [q[0], q[1] - drop, q[2]]

    const lods = counts.map((c) => {
      const b = new MeshBuilder()
      solidFrom(p, planes, c, depths).emit(b, shift)
      return b.build()
    })
    const full = solidFrom(p, planes, counts[0]!, depths)
    const pts = full.points().map(shift)
    return {
      // The impostor IS the coarsest rung. A rock at LOD2 is already a ten-face
      // block of a couple of dozen triangles; a crossed card would cost more
      // AND read as a paper cutout the moment the sun came off-axis, which is
      // the one thing a solid opaque form must never do.
      parts: [{ slot: 'body', lods, impostor: lods[lods.length - 1]! }],
      // Exact, and free: the render mesh is already convex, so the proxy is the
      // same solid. Nothing else in the library gets a proxy this tight.
      collider: solidCollider(hullShape(pts)),
      bounds: boundsFromPoints(pts),
    }
  },
})
