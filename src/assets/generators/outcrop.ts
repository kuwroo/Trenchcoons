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

import { Polytope, type Plane } from '../hull'
import { MeshBuilder, dot, normalize, rotY, type Vec3 } from '../mesh'
import { coarseSolid, coarseUnder } from '../impostor'
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

    // Courses OVERLAP. The first version butted them end to end and then cut an
    // undercut off the bottom of each, which left a gap between every pair and
    // the outcrop rendered as a stack of floating slabs — the single worst
    // thing in the first capture round. A course is `overlap` taller than its
    // spacing, so consecutive courses interpenetrate and the stack is one
    // solid mass whose steps are the parts of a course that stick out past the
    // one above.
    // 0.8, not 0.4. Each course loses material at BOTH ends — the undercut
    // wedge at its base and the bedding cut across its top — so a 0.4 nominal
    // overlap could net out to nothing once the cuts landed, and the stack
    // rendered as a pile of detached slabs with grass showing through the gaps.
    // Courses interpenetrate by most of their own thickness now; the steps are
    // still the parts of a course that stick out past the one above.
    const OVERLAP = 0.8
    const layerH = p.height / (p.strata + OVERLAP)

    // Every course's planes and placement are drawn ONCE, up front, and the LOD
    // ladder then renders PREFIXES of the plane list — exactly the scheme
    // rock.ts uses. The old ladder re-hulled each course at LOD1 with 14
    // support directions, which cost MORE than the cut solid it replaced:
    // outcrop-step went 84 -> 256 triangles and outcrop-shelf 68 -> 185, so the
    // asset got dearer the further away it was. Dropping cut planes can only
    // ever make the solid bigger, never punch a hole in it, so a prefix is a
    // valid simplification and it is monotone by construction.
    interface Course {
      hx: number
      hy: number
      hz: number
      y0: number
      dx: number
      dz: number
      yaw: number
      planes: Plane[]
      depths: number[]
    }
    const courses: Course[] = []
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
      const planes: Plane[] = []
      const depths: number[] = []

      // The undercut. One shallow plane sloping in at the base of the layer,
      // which is what makes the shelf above read as an overhang and puts a
      // sliver of the darkest value under every step.
      if (p.lip > 0) {
        const a = rng.range(0, Math.PI * 2)
        // Steep, not shallow. A near-horizontal plane trims the whole base off
        // the course; a plane leaning 60 degrees takes a wedge out of ONE side
        // of it, which is what an undercut is and what puts a sliver of the
        // darkest value under the step.
        planes.push({ n: normalize([Math.cos(a) * 0.86, -0.51, Math.sin(a) * 0.86]), d: 0 })
        depths.push(p.lip)
      }
      // FRACTURE FACES, AND THEY MUST BE OBLIQUE. The old bias was
      // `rng.range(0.86, 0.99)`, i.e. every cut plane within 8 degrees of
      // vertical AND within a few degrees of the block's own faces once the
      // yaw landed — so cliff-block, with eight cuts authored, came back as
      // three axis-aligned rectangular boxes stacked in a cross and read as
      // architecture rather than as rock. 0.42..0.92 spans genuinely tilted
      // planes through near-vertical ones, which is the range the reference's
      // fracture faces actually occupy.
      for (let c = 0; c < p.cuts; c++) {
        // ONE OBLIQUE CUT PER COURSE, and only one.
        //
        // Every cut used to be within 8 degrees of vertical, so cliff-block —
        // eight cuts authored — came back as three rectangular boxes stacked in
        // a cross, reading as architecture rather than as rock. Making them ALL
        // oblique is worse: five tilted planes at 20% depth each reduced a
        // 9 x 6 x 2 m course to a 90 m2 shell of thin fins, measured, and the
        // whole outcrop rendered as crumpled paper. One tilted plane per course,
        // at half the usual bite, gives the stack its off-axis facet without
        // eating the mass.
        const oblique = c === 0
        planes.push({
          n: randomDirection(rng, oblique ? rng.range(0.6, 0.78) : rng.range(0.86, 0.99)),
          d: 0,
        })
        depths.push(oblique ? rng.range(0.05, 0.13) : rng.range(0.06, 0.3))
      }
      // One near-horizontal cut per course, on the TOP. The reference's shelves
      // are not level rectangles — each one tilts a few degrees and catches the
      // key as a single flat value, which is the whole read.


      courses.push({ hx, hy, hz, y0: i * layerH, dx: cx, dz: cz, yaw, planes, depths })
      const slide = p.size * 0.5 * p.setback * p.step
      cx += rng.range(-slide, slide)
      cz += rng.range(-slide, slide)
      yaw += rng.range(-p.twist, p.twist)
    }

    /** One course, cut by the first `count` of its planes and placed. */
    const courseSolid = (c: Course, count: number): {
      solid: Polytope
      put: (q: Vec3) => Vec3
    } => {
      const solid = Polytope.box(c.hx, c.hy, c.hz)
      for (let i = 0; i < Math.min(count, c.planes.length); i++) {
        const pl = c.planes[i]!
        const pts = solid.points()
        if (pts.length === 0) break
        let s = -Infinity
        let e = Infinity
        for (const q of pts) { s = Math.max(s, dot(pl.n, q)); e = Math.min(e, dot(pl.n, q)) }
        solid.clip({ n: pl.n, d: s - (s - e) * (c.depths[i] ?? 0.2) })
      }
      // Place: lift onto its course so the base of the bottom slab is exactly
      // y = 0, slide, and turn.
      const put = (q: Vec3): Vec3 => {
        const r = rotY(q, c.yaw)
        return [r[0] + c.dx, r[1] + c.y0 + c.hy, r[2] + c.dz]
      }
      return { solid, put }
    }

    const layerPoints: Vec3[][] = []
    const shapes: ColliderShape[] = []
    const all: Vec3[] = []
    const b = new MeshBuilder()
    for (const c of courses) {
      const { solid, put } = courseSolid(c, c.planes.length)
      solid.emit(b, put)
      const pts = solid.points().map(put)
      layerPoints.push(pts)
      all.push(...pts)
      // One hull per LAYER, not one around the stack. A single hull would fill
      // in every step and the kart would collide with a metre of open air above
      // each shelf — which is the whole point of an outcrop being drivable.
      shapes.push(hullShape(pts))
    }

    // LOD1 keeps every course and drops the later cuts: the steps survive, the
    // finer fracture facets do not. LOD2 collapses the stack into one solid,
    // which is all that is left of it past a couple of hundred metres anyway.
    const lodMid = new MeshBuilder()
    for (const c of courses) {
      const keep = Math.max(1, Math.round(c.planes.length * 0.3))
      const { solid, put } = courseSolid(c, keep)
      solid.emit(lodMid, put)
    }
    const geoLod0 = b.build()
    const geoLod1 = lodMid.build()
    const lodFar = coarseUnder(all, (geoLod1.index?.count ?? 0) / 3)

    return {
      parts: [{
        slot: 'body',
        lods: [geoLod0, geoLod1, lodFar],
        impostor: coarseSolid(all, 8),
      }],
      collider: solidCollider(...shapes),
      bounds: boundsFromPoints(all),
    }
  },
})
