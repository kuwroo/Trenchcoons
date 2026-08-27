// Outcrop: the stepped rock shelves that structure the reference.
//
// In refs/genshin/grasslands.jpg the mid-ground is not made of rocks, it is
// made of LAYERS — three or four horizontal shelves stacked with each one set
// back from the one below, grass growing on every step, and a vertical face
// between them. That silhouette is what turns a hillside into terrain you can
// read the depth of, and it is a completely different asset from a boulder: a
// boulder is a lump on the ground, an outcrop is a piece of the ground.
//
// Built as a stack of independently-cut slabs rather than as one solid, for
// three reasons: the steps stay exactly horizontal (which is what makes them
// read as bedding), each layer can be set back and turned a little so the stack
// is not a wedding cake, and the collision proxy comes out as one convex hull
// per layer — which is a far better fit than one hull around the whole stack,
// where the kart would collide with a metre of empty air above every step.

import { Polytope } from '../hull'
import { MeshBuilder, dot, normalize, rotY, type Vec3 } from '../mesh'
import { coarseSolid, emitCoarse } from '../impostor'
import { boundsFromPoints, hullShape, solidCollider } from '../collider'
import { defineGenerator, randomDirection, type RawAsset } from '../generator'
import { int, num } from '../schema'
import type { ColliderShape } from '../types'

const schema = {
  size: num(7, 1.5, 40, 'Width of the bottom layer.', 'm'),
  height: num(4.2, 0.6, 30, 'Total height of the stack.', 'm'),
  strata: int(3, 1, 6, 'Number of stacked layers.'),
  setback: num(0.22, 0, 0.55, 'How far each layer shrinks relative to the one below.'),
  step: num(0.35, 0, 1, 'How far each layer slides sideways, as a fraction of the setback.'),
  cuts: int(5, 0, 14, 'Fracture planes per layer.'),
  aspect: num(0.72, 0.2, 1, 'Depth as a fraction of width.'),
  lip: num(0.1, 0, 0.4, 'How far a layer overhangs at its base — undercuts the face.'),
  twist: num(0.18, 0, 0.8, 'Yaw jitter between layers.', 'rad'),
} as const

export const outcrop = defineGenerator({
  info: { name: 'outcrop', slots: ['body'], defaultSurfaces: { body: 'cliff' } },
  schema,
  generate(p, ctx): RawAsset {
    const rng = ctx.rng
    const layerPoints: Vec3[][] = []
    const shapes: ColliderShape[] = []
    const all: Vec3[] = []
    const b = new MeshBuilder()

    // Courses OVERLAP. The first version butted them end to end and then cut an
    // undercut off the bottom of each, which left a gap between every pair and
    // the outcrop rendered as a stack of floating slabs — the single worst
    // thing in the first capture round. A course is `overlap` taller than its
    // spacing, so consecutive courses interpenetrate and the stack is one
    // solid mass whose steps are the parts of a course that stick out past the
    // one above.
    const OVERLAP = 0.4
    const layerH = p.height / (p.strata + OVERLAP)
    let cx = 0
    let cz = 0
    let yaw = 0
    for (let i = 0; i < p.strata; i++) {
      const shrink = Math.pow(1 - p.setback, i)
      const hx = p.size * 0.5 * shrink
      const hz = p.size * 0.5 * p.aspect * shrink
      // Layers are slabs, not blocks: the height is fixed by the stack, so a
      // tall thin outcrop is three tall thin slabs, not three cubes.
      const hy = layerH * 0.5 * (1 + OVERLAP)
      const y0 = i * layerH
      const solid = Polytope.box(hx, hy, hz)

      // The undercut. One shallow plane sloping in at the base of the layer,
      // which is what makes the shelf above read as an overhang and puts a
      // sliver of the darkest value under every step.
      if (p.lip > 0) {
        const a = rng.range(0, Math.PI * 2)
        // Steep, not shallow. A near-horizontal plane trims the whole base off
        // the course; a plane leaning 60 degrees takes a wedge out of ONE side
        // of it, which is what an undercut is and what puts a sliver of the
        // darkest value under the step.
        const n = normalize([Math.cos(a) * 0.86, -0.51, Math.sin(a) * 0.86])
        const pts = solid.points()
        let s = -Infinity
        let e = Infinity
        for (const q of pts) { s = Math.max(s, dot(n, q)); e = Math.min(e, dot(n, q)) }
        solid.clip({ n, d: s - (s - e) * p.lip })
      }
      // Vertical fracture faces only. A bedding plane inside a layer would
      // fight the layer boundary, which is the bedding plane that matters.
      for (let c = 0; c < p.cuts; c++) {
        const n = randomDirection(rng, rng.range(0.86, 0.99))
        const pts = solid.points()
        let s = -Infinity
        let e = Infinity
        for (const q of pts) { s = Math.max(s, dot(n, q)); e = Math.min(e, dot(n, q)) }
        solid.clip({ n, d: s - (s - e) * rng.range(0.06, 0.3) })
      }

      // Place: lift onto its course, slide, and turn.
      const dx = cx
      const dz = cz
      const ry = yaw
      const put = (q: Vec3): Vec3 => {
        const r = rotY(q, ry)
        return [r[0] + dx, r[1] + y0 + hy, r[2] + dz]
      }
      solid.emit(b, put)
      const pts = solid.points().map(put)
      layerPoints.push(pts)
      all.push(...pts)
      // One hull per LAYER, not one around the stack. A single hull would fill
      // in every step and the kart would collide with a metre of open air above
      // each shelf — which is the whole point of an outcrop being drivable.
      shapes.push(hullShape(pts))

      const slide = p.size * 0.5 * p.setback * p.step
      cx += rng.range(-slide, slide)
      cz += rng.range(-slide, slide)
      yaw += rng.range(-p.twist, p.twist)
    }

    // LOD1 keeps every layer, at hull resolution: the steps survive, the
    // fracture facets do not. LOD2 collapses the stack into one solid, which is
    // all that is left of it past a couple of hundred metres anyway.
    const lodMid = new MeshBuilder()
    for (const pts of layerPoints) emitCoarse(lodMid, pts, 14)
    const lodFar = new MeshBuilder()
    emitCoarse(lodFar, all, 10)

    return {
      parts: [{
        slot: 'body',
        lods: [b.build(), lodMid.build(), lodFar.build()],
        impostor: coarseSolid(all, 8),
      }],
      collider: solidCollider(...shapes),
      bounds: boundsFromPoints(all),
    }
  },
})
