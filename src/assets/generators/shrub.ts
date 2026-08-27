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

import { Polytope } from '../hull'
import { MeshBuilder, dot, type Vec3 } from '../mesh'
import { crossCards, emitCoarse } from '../impostor'
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
  solid: bool(false, 'Whether the kart collides with it.'),
} as const

export const shrub = defineGenerator({
  info: { name: 'shrub', slots: ['body'], defaultSurfaces: { body: 'bush' } },
  schema,
  generate(p, ctx): RawAsset {
    const rng = ctx.rng
    const b = new MeshBuilder()
    const all: Vec3[] = []
    const lobePts: Vec3[][] = []

    const R = p.size * 0.5
    const H = p.size * p.height
    for (let i = 0; i < p.lobes; i++) {
      const first = i === 0
      const k = first ? 1 : p.lobeSize * rng.range(0.7, 1.15)
      const hx = R * k
      const hy = H * 0.5 * k
      const hz = R * k * rng.range(0.8, 1)
      const solid = Polytope.box(hx, hy, hz)
      // Facet the block down to a rounded mass. Uniform directions, unlike the
      // rock's two families: a bush has no bedding, it just has bulk.
      for (let c = 0; c < p.cuts; c++) {
        const n = randomDirection(rng, rng.range(-0.25, 0.25))
        const pts = solid.points()
        let s = -Infinity
        let e = Infinity
        for (const q of pts) { s = Math.max(s, dot(n, q)); e = Math.min(e, dot(n, q)) }
        solid.clip({ n, d: s - (s - e) * rng.range(0.14, 0.34) })
      }
      const a = rng.range(0, Math.PI * 2)
      const off = first ? 0 : p.size * p.scatter * rng.range(0.45, 1)
      const dx = Math.cos(a) * off
      const dz = Math.sin(a) * off
      // Lift so the lobe sits ON the ground plane, then sag the outer ones.
      const lift = hy * (1 - (first ? 0 : p.sag * rng.range(0.4, 1)))
      const put = (q: Vec3): Vec3 => [q[0] + dx, q[1] + lift, q[2] + dz]
      solid.emit(b, put)
      const pts = solid.points().map(put)
      lobePts.push(pts)
      all.push(...pts)
    }

    const lodMid = new MeshBuilder()
    for (const pts of lobePts) emitCoarse(lodMid, pts, 14)
    const lodFar = new MeshBuilder()
    emitCoarse(lodFar, all, 10)

    const bounds = boundsFromPoints(all)
    return {
      parts: [{
        slot: 'body',
        lods: [b.build(), lodMid.build(), lodFar.build()],
        impostor: crossCards(all, 0.8),
      }],
      collider: p.solid
        ? solidCollider(cylinderShape(
          bounds.footprint * 0.72, bounds.height * 0.5, [0, bounds.height * 0.5, 0],
        ))
        : noCollision(),
      bounds,
    }
  },
})
