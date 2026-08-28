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
import type * as THREE from 'three/webgpu'
import { MeshBuilder, dot, normalize, type Vec3 } from '../mesh'
import { boundsFromPoints, hullShape, noCollision, solidCollider } from '../collider'
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
  solidAbove: num(0.7, 0, 20, 'Authored height above which the kart collides with it.', 'm'),
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
    // Authored, not jittered — see `collider` below.
    const a = ctx.authored as Partial<Record<keyof typeof schema, number>>
    const nominal = (a.size ?? p.size) * (a.height ?? p.height)
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
    // 62% and 45%, not 55% and 28%.
    //
    // The first three planes are AUTHORED — the tilted top and two base bevels
    // — so a rung with only four planes is a box cut by top-plus-bevels-plus-one,
    // which is a WEDGE. Put side by side with LOD0 in one frame
    // (shots/forge/forge-ladder-rock-medium.png) the old 28% rung read as a
    // completely different object: a wide flat overhang where LOD0 is a chunky
    // block. A rock's coarsest rung is also its impostor, so that silhouette is
    // what everything past the LOD2 distance sees, forever.
    const targets = [
      planes.length,
      Math.max(5, Math.round(planes.length * 0.62)),
      Math.max(5, Math.round(planes.length * 0.45)),
    ]
    // WHERE THE BLOCK SITS. `Polytope.box` is centred on y = 0, so the cut
    // solid straddles the origin — and the first version of this line was
    // `q[1] - drop`, which sank it FURTHER. Measured against a ground plane at
    // y = 0, rock-medium spanned -1.188..0.612 (66% underground against an
    // authored embed of 0.16) and rock-slab variant 1 lay entirely below the
    // turf and rendered nothing at all. Flat sculptural rock is the defining
    // form in refs/genshin/grasslands.jpg and the library was hiding three
    // quarters of it.
    //
    // Derived from the solid's OWN measured extent rather than from the
    // authored block height, because the cuts move both ends: `embed` then
    // means exactly what the schema says it means — the fraction of the visible
    // form that is under the turf — and the invariant below is exact rather
    // than approximate.
    const full = solidFrom(p, planes, targets[0]!, depths)
    const fb = full.bounds()
    const span = Math.max(1e-6, fb.max[1] - fb.min[1])
    const lift = -fb.min[1] - p.embed * span
    const shift = (q: Vec3): Vec3 => [q[0], q[1] + lift, q[2]]

    // A FLAT FLOOR AT THE EMBED DEPTH, on every rung.
    //
    // Dropping cut planes can only make a solid bigger, and one of the
    // directions it grows in is DOWN — the base bevels are among the planes a
    // coarse rung drops, so boulder-large's LOD1 hung 0.66 m lower than its
    // LOD0 and the coarse rungs sank as they simplified. Clipping every rung
    // with the same horizontal plane at the authored embed depth makes the
    // whole ladder share one base, and the face it adds is under the turf where
    // nothing can see it.
    const floor: Plane = { n: [0, -1, 0], d: -fb.min[1] }

    /**
     * The ladder, with each rung verified STRICTLY cheaper than the one above.
     *
     * Not just `planes.length * 0.55`: dropping a cut sometimes GROWS the
     * triangle count, because the faces the cut used to trim come back as
     * wider polygons that fan into more triangles. rock-small variant 1 went
     * 28 -> 32 that way. So the target is a starting point and the rung walks
     * down from it until it is genuinely cheaper, which makes the ladder
     * monotone by construction instead of by hope.
     */
    const lods: THREE.BufferGeometry[] = []
    let prev = Infinity
    for (const target of targets) {
      let built: THREE.BufferGeometry | null = null
      for (let c = target; c >= 1; c--) {
        const b = new MeshBuilder()
        solidFrom(p, planes, c, depths).clip(floor).emit(b, shift)
        const geo = b.build()
        const tris = (geo.index?.count ?? 0) / 3
        if (tris < prev) { built = geo; prev = tris; break }
        geo.dispose()
      }
      if (!built) {
        // Nothing cheaper exists; repeat the previous rung rather than emit an
        // inverted one. The registry's ladder is allowed to be short.
        break
      }
      lods.push(built)
    }
    const pts = full.clone().clip(floor).points().map(shift)
    // Self-checking, because this is the exact bug that shipped: the buried
    // fraction of the rock must be the authored `embed`. A future edit to the
    // cut order or the plane families cannot silently sink the library again.
    const bounds = boundsFromPoints(pts)
    const buried = -(fb.min[1] + lift) / Math.max(1e-6, bounds.height)
    if (Math.abs(buried - p.embed) > 1e-3) {
      throw new Error(
        `${ctx.id}: rock sits ${(buried * 100).toFixed(1)}% underground, ` +
        `authored embed ${(p.embed * 100).toFixed(1)}%`,
      )
    }
    return {
      // The impostor IS the coarsest rung. A rock at LOD2 is already a ten-face
      // block of a couple of dozen triangles; a crossed card would cost more
      // AND read as a paper cutout the moment the sun came off-axis, which is
      // the one thing a solid opaque form must never do.
      parts: [{ slot: 'body', lods, impostor: lods[lods.length - 1]! }],
      // SOLID BY SIZE. Every rock used to be solid regardless of size, and the
      // consequence was measured in the running game: of 30 collidable scatter
      // instances in streaming range, the median radius was 0.21 m — the solid
      // set was dominated by `rock-pebble`, authored 0.34 m across and 0.20 m
      // tall. A twenty-centimetre pebble was stopping the kart dead, so driving
      // anywhere gravelly was a series of collisions with things the player
      // cannot even see.
      //
      // Tested on the AUTHORED nominal height rather than the realised bounds,
      // for the reason `shrub` documents: `seedJitter` moves the realised size
      // per variant, so the same def would answer differently for two siblings
      // and the kart would bounce off one pebble and roll over its twin.
      //
      // 0.7 m leaves rock-small (0.76), rock-medium (1.80) and boulder-large
      // (4.59) solid, and lets the kart through rock-pebble (0.20) and
      // rock-slab (0.59) — a slab is 2.7 m wide and knee-high, which reads as
      // something you drive over, not something you stop against.
      collider: nominal >= p.solidAbove ? solidCollider(hullShape(pts)) : noCollision(),
      bounds,
    }
  },
})
