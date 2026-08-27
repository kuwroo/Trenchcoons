// Broadleaf shrubs and bushes.
//
// The mid-ground of refs/genshin/grasslands.jpg is dotted with dark rounded
// masses that are doing one specific job: they are the DARK ANCHOR. See
// assets/defs/surfaces/bush.json — the frame's value range has no bottom
// without them, and "lifted shadows" degenerates into "no darks at all".
//
// Form-wise a bush here is a small CLUSTER of faceted lobes, not one sphere.
// Two reasons, and the first is the one that shows:
//
//   * A single blob has one silhouette and reads as a ball. Three or four lobes
//     of different sizes packed together give an irregular outline with real
//     concavities, and the concavities are where the darkest values live.
//   * The lobes are plane-cut solids (hull.ts), not subdivided spheres, so the
//     bush shares the flat-facet language of the rock beside it. That coherence
//     is most of what makes a scatter set look like one world rather than like
//     an asset pack.
//
// A bush is NOT necessarily an obstacle. `solid` decides, and small ones are
// deliberately not: nothing kills the feel of an open-world driving game faster
// than being stopped by a knee-high shrub.

import { Polytope, type Plane } from '../hull'
import { MeshBuilder, dot, type Vec3 } from '../mesh'
import { coarseUnder, crossCards } from '../impostor'
import { boundsFromPoints, cylinderShape, noCollision, solidCollider } from '../collider'
import { defineGenerator, randomDirection, type RawAsset } from '../generator'
import { bool, int, num } from '../schema'

const schema = {
  size: num(1.9, 0.3, 14, 'Overall width.', 'm'),
  height: num(0.62, 0.15, 1.6, 'Height as a fraction of width. Under 1 the bush is squat.'),
  lobes: int(4, 1, 8, 'Masses in the cluster.'),
  lobeSize: num(0.62, 0.3, 1, 'Size of a lobe relative to the whole.'),
  cuts: int(7, 2, 16, 'Facet planes per lobe. Low is chunky; high goes back to a ball.'),
  scatter: num(0.34, 0, 0.8, 'How far lobes sit from the centre, as a fraction of `size`.'),
  sag: num(0.18, 0, 0.6, 'How much the outer lobes drop toward the ground.'),
  solid: bool(false, 'Force a collision proxy regardless of size.'),
  solidAbove: num(1.5, 0.2, 20, 'Height above which the kart collides with it anyway.', 'm'),
} as const

export const shrub = defineGenerator({
  info: { name: 'shrub', slots: ['body'], defaultSurfaces: { body: 'bush' } },
  schema,
  generate(p, ctx): RawAsset {
    const rng = ctx.rng

    // Lobes are drawn ONCE and the ladder renders plane PREFIXES, exactly as in
    // rock.ts and outcrop.ts. The old ladder re-hulled every lobe at LOD1 with
    // 14 support directions and came out DEARER than LOD0 — shrub-broadleaf
    // went 100 -> 239 triangles, bush-round 96 -> 155 — so past the switch
    // distance the highest-instance-count solid asset in the set cost 2.4x
    // more than it did up close.
    interface Lobe {
      hx: number
      hy: number
      hz: number
      dx: number
      dz: number
      lift: number
      planes: Plane[]
      depths: number[]
    }
    const lobes: Lobe[] = []
    const R = p.size * 0.5
    const H = p.size * p.height
    for (let i = 0; i < p.lobes; i++) {
      const first = i === 0
      const k = first ? 1 : p.lobeSize * rng.range(0.7, 1.15)
      const hx = R * k
      const hy = H * 0.5 * k
      const hz = R * k * rng.range(0.8, 1)
      const planes: Plane[] = []
      const depths: number[] = []
      // Facet the block down to a rounded mass. Uniform directions, unlike the
      // rock's two families: a bush has no bedding, it just has bulk.
      for (let c = 0; c < p.cuts; c++) {
        planes.push({ n: randomDirection(rng, rng.range(-0.25, 0.25)), d: 0 })
        depths.push(rng.range(0.14, 0.34))
      }
      const a = rng.range(0, Math.PI * 2)
      const off = first ? 0 : p.size * p.scatter * rng.range(0.45, 1)
      lobes.push({
        hx, hy, hz,
        dx: Math.cos(a) * off,
        dz: Math.sin(a) * off,
        // Lift so the lobe sits ON the ground plane, then sag the outer ones.
        lift: hy * (1 - (first ? 0 : p.sag * rng.range(0.4, 1))),
        planes,
        depths,
      })
    }

    const lobeSolid = (l: Lobe, count: number): {
      solid: Polytope
      put: (q: Vec3) => Vec3
    } => {
      const solid = Polytope.box(l.hx, l.hy, l.hz)
      for (let c = 0; c < Math.min(count, l.planes.length); c++) {
        const n = l.planes[c]!.n
        const pts = solid.points()
        if (pts.length === 0) break
        let s = -Infinity
        let e = Infinity
        for (const q of pts) { s = Math.max(s, dot(n, q)); e = Math.min(e, dot(n, q)) }
        solid.clip({ n, d: s - (s - e) * (l.depths[c] ?? 0.24) })
      }
      return { solid, put: (q: Vec3): Vec3 => [q[0] + l.dx, q[1] + l.lift, q[2] + l.dz] }
    }

    const b = new MeshBuilder()
    const all: Vec3[] = []
    for (const l of lobes) {
      const { solid, put } = lobeSolid(l, l.planes.length)
      solid.emit(b, put)
      all.push(...solid.points().map(put))
    }

    const lodMid = new MeshBuilder()
    for (const l of lobes) {
      const { solid, put } = lobeSolid(l, Math.max(2, Math.round(l.planes.length * 0.45)))
      solid.emit(lodMid, put)
    }
    const geoLod0 = b.build()
    const geoLod1 = lodMid.build()
    const lodFar = coarseUnder(all, (geoLod1.index?.count ?? 0) / 3, 10)

    const bounds = boundsFromPoints(all)
    return {
      parts: [{
        slot: 'body',
        lods: [geoLod0, geoLod1, lodFar],
        impostor: crossCards(all, 0.8),
      }],
      // SOLID BY SIZE, not by a hand-set flag on every def. A knee-high bush the
      // kart is stopped by is the fastest way to make an open world feel like a
      // corridor, and a 2.3 m mass taller than the kart that the kart drives
      // straight THROUGH is the fastest way to make it feel like a hologram.
      // `solid` forces it on; anything over `solidAbove` metres tall gets a
      // proxy whether the def asked for one or not.
      collider: p.solid || bounds.height >= p.solidAbove
        ? solidCollider(cylinderShape(
          bounds.footprint * 0.72, bounds.height * 0.5, [0, bounds.height * 0.5, 0],
        ))
        : noCollision(),
      bounds,
    }
  },
})
