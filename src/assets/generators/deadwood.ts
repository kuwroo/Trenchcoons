// Fallen logs, broken stumps, exposed roots.
//
// The small props do a job out of proportion to their triangle count: they are
// the only assets in the set with a strong HORIZONTAL axis. Rock is blocky,
// conifers and grass are vertical, bushes are round — a meadow made only of
// those reads as a repeating stamp. One log lying across the slope breaks it,
// and it also does the thing ART_BIBLE §2 asks of every asset: it reads as a
// clear silhouette with no interior detail at all.
//
// One generator, three forms, because they are the same construction — a
// tapered faceted tube on a curved axis — assembled differently. A stump is a
// short vertical one with a torn top; roots are several thin ones arcing out of
// the ground; a log is a long horizontal one with cut ends.

import { MeshBuilder, loft, normalize, rotY, type Vec3 } from '../mesh'
import { crossCards, emitCoarse } from '../impostor'
import { boundsFromPoints, cylinderShape, hullShape, noCollision, solidCollider } from '../collider'
import { defineGenerator, type GenContext, type RawAsset } from '../generator'
import { int, num, oneOf, type Params } from '../schema'
import type { Rng } from '../../core/rng'

const schema = {
  form: oneOf('log', ['log', 'stump', 'roots'] as const, 'Which prop this def is.'),
  length: num(3.4, 0.3, 12, 'Log length, or stump height.', 'm'),
  radius: num(0.28, 0.04, 1.4, 'Radius at the thick end.', 'm'),
  taper: num(0.72, 0.25, 1, 'Radius at the thin end, as a fraction of the thick one.'),
  sides: int(8, 4, 14, 'Facets around the bole.'),
  bow: num(0.06, 0, 0.5, 'Sideways curve of the axis, as a fraction of length.'),
  roots: int(0, 0, 7, 'Exposed roots splaying from the base.'),
  rootLength: num(0.9, 0.2, 4, 'How far a root reaches from the bole.', 'm'),
  rootRise: num(0.2, 0, 1.2, 'How high a root arches before it dives underground.', 'm'),
  torn: num(0.35, 0, 1, 'Jaggedness of a broken end. 0 is a clean saw cut.'),
} as const

type P = Params<typeof schema>

/** A faceted tapered tube along a caller-supplied axis. */
function bole(
  b: MeshBuilder, sides: number, courses: number,
  at: (t: number) => Vec3, radiusAt: (t: number) => number,
  cap0: boolean, cap1: boolean, tear: number, rng: Rng,
): Vec3[][] {
  // A torn end is capped by a FAN to the ring's mean height rather than by one
  // flat polygon. A single polygon through jittered points is planar-fitted and
  // averages the splinters away — the tear is generated and then thrown out,
  // which is what made the first stump read as sawn off.
  const fanCap = tear > 0 && cap1
  const rings: Vec3[][] = []
  for (let c = 0; c <= courses; c++) {
    const t = c / courses
    const centre = at(t)
    const next = at(Math.min(1, t + 1e-3))
    const prev = at(Math.max(0, t - 1e-3))
    const axis = normalize([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]])
    // Any two vectors perpendicular to the axis will do; pick the more stable.
    const seed: Vec3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = normalize([
      seed[1] * axis[2] - seed[2] * axis[1],
      seed[2] * axis[0] - seed[0] * axis[2],
      seed[0] * axis[1] - seed[1] * axis[0],
    ])
    // `u x axis`, not `axis x u`: the ring has to run counter-clockwise about
    // the direction of travel or `loft` builds the tube inside-out. See the
    // winding convention on `loft` in mesh.ts.
    const v: Vec3 = [
      u[1] * axis[2] - u[2] * axis[1],
      u[2] * axis[0] - u[0] * axis[2],
      u[0] * axis[1] - u[1] * axis[0],
    ]
    const r = radiusAt(t)
    const ring: Vec3[] = []
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2
      // The tear is applied along the AXIS, not radially: a snapped trunk has
      // splinters of different lengths, not a lumpy circumference.
      const pull = (c === courses ? tear : 0) * rng.range(-1, 1) * r
      const ca = Math.cos(a) * r
      const sa = Math.sin(a) * r
      ring.push([
        centre[0] + u[0] * ca + v[0] * sa + axis[0] * pull,
        centre[1] + u[1] * ca + v[1] * sa + axis[1] * pull,
        centre[2] + u[2] * ca + v[2] * sa + axis[2] * pull,
      ])
    }
    rings.push(ring)
  }
  loft(b, rings, { closed: true, capStart: cap0, capEnd: fanCap ? false : cap1 })
  if (fanCap) {
    const top = rings[rings.length - 1]!
    let my = 0
    let mx = 0
    let mz = 0
    for (const q of top) { mx += q[0]; my += q[1]; mz += q[2] }
    const c: Vec3 = [mx / top.length, my / top.length, mz / top.length]
    for (let i = 0; i < top.length; i++) b.tri(c, top[i]!, top[(i + 1) % top.length]!)
  }
  return rings
}

function pointsOf(rings: readonly (readonly Vec3[])[]): Vec3[] {
  const out: Vec3[] = []
  for (const r of rings) out.push(...r)
  return out
}

function build(p: P, ctx: GenContext, sides: number, courses: number): {
  b: MeshBuilder
  pts: Vec3[]
} {
  const b = new MeshBuilder()
  const rng = ctx.rng.fork(`deadwood:${p.form}`)
  const pts: Vec3[] = []
  const r0 = p.radius
  const r1 = p.radius * p.taper

  if (p.form === 'log') {
    const L = p.length
    const bow = L * p.bow
    const roll = rng.range(0, Math.PI * 2)
    const axis = (t: number): Vec3 => rotY([
      (t - 0.5) * L,
      r0 * (1 - 0.12 * Math.sin(t * Math.PI)),
      Math.sin(t * Math.PI) * bow,
    ], roll)
    pts.push(...pointsOf(bole(
      b, sides, courses, axis, (t) => r0 + (r1 - r0) * t, true, true, p.torn * 0.5, rng,
    )))
  } else if (p.form === 'stump') {
    const H = p.length
    const lean = rng.range(-p.bow, p.bow)
    const axis = (t: number): Vec3 => [t * H * lean, t * H, 0]
    pts.push(...pointsOf(bole(
      b, sides, courses,
      axis,
      // Root flare: the bottom fifth swells, which is what stops a stump from
      // reading as a bollard.
      (t) => (r0 + (r1 - r0) * t) * (1 + 0.6 * Math.max(0, 1 - t * 5)),
      false, true, p.torn, rng,
    )))
  }

  // The `roots` form has no bole, so without something at the centre the arcs
  // converge on a point in mid-air and the prop reads as a starfish. A squat
  // stub — the last few centimetres of a rotted-out trunk — is what the roots
  // are roots OF.
  if (p.form === 'roots') {
    pts.push(...pointsOf(bole(
      b, sides, 2,
      (t) => [0, -r0 * 0.25 + t * r0 * 0.85, 0],
      (t) => r0 * (0.78 - 0.3 * t), false, true, p.torn, rng,
    )))
  }

  // Roots, shared by `stump` and `roots`. Arcs that leave the bole, crest, and
  // dive back under y=0 — the underground half is never drawn.
  const nRoots = p.form === 'roots' ? Math.max(2, p.roots || 4) : p.roots
  for (let i = 0; i < nRoots; i++) {
    const a = (i / nRoots) * Math.PI * 2 + rng.range(-0.3, 0.3)
    const len = p.rootLength * rng.range(0.65, 1.25)
    const rise = p.rootRise * rng.range(0.6, 1.3)
    const rr = r0 * rng.range(0.34, 0.52)
    const axis = (t: number): Vec3 => [
      Math.cos(a) * (r0 * 0.5 + len * t),
      // Out of the ground, over the crest, back under. Ends below zero so the
      // root is cut off by the terrain rather than stopping in mid-air.
      // Flatter and diving harder at the far end. The first arc was a tall
      // half-circle and five of them read as a spider, not as roots.
      rise * Math.sin(t * Math.PI * 0.78) - 0.4 * t * t * len * 0.35,
      Math.sin(a) * (r0 * 0.5 + len * t),
    ]
    pts.push(...pointsOf(bole(
      b, Math.max(4, sides - 3), Math.max(3, courses - 1), axis,
      (t) => rr * (1 - 0.8 * t), true, true, 0, rng,
    )))
  }
  return { b, pts }
}

export const deadwood = defineGenerator({
  info: { name: 'deadwood', slots: ['body'], defaultSurfaces: { body: 'bark' } },
  schema,
  generate(p, ctx): RawAsset {
    const lod0 = build(p, ctx, p.sides, 5)
    const lod1 = build(p, ctx, Math.max(5, p.sides - 3), 3)
    const lodFar = new MeshBuilder()
    emitCoarse(lodFar, lod0.pts, 10)

    const bounds = boundsFromPoints(lod0.pts)
    return {
      parts: [{
        slot: 'body',
        lods: [lod0.b.build(), lod1.b.build(), lodFar.build()],
        // A log is solid and opaque, so it gets a card only at the range where
        // it is a few pixels of brown; low splay keeps it from ballooning.
        impostor: crossCards(lod0.pts, 0.35),
      }],
      collider:
        p.form === 'log'
          // A gently bowed tube is convex to within a few centimetres, so one
          // hull is both exact enough and orientation-free — which matters
          // because a lying log has no canonical axis for a capsule to use.
          ? solidCollider(hullShape(lod0.pts))
          : p.form === 'stump'
            ? solidCollider(cylinderShape(
              p.radius * 1.15, p.length * 0.5, [0, p.length * 0.5, 0],
            ))
            // Roots sit ankle-high and sprawl. Colliding them would stop the
            // kart dead on scenery the player cannot read as an obstacle, which
            // is the worst kind of collision in a driving game.
            : noCollision(),
      bounds,
    }
  },
})
