// Conifer: chunky, readable, layered tiers.
//
// The trees in refs/genshin/grasslands.jpg are not cones and they are not
// canopy blobs. Each one is a stack of separate PLATES — flat-bottomed, lobed
// at the rim, drooping slightly at the tips, with daylight visible between one
// plate and the next. Three properties of that read matter and the greybox's
// stacked `ConeGeometry` has none of them:
//
//   1. The plates are FLAT UNDERNEATH. That underside is the darkest surface on
//      the tree and it is what separates one tier from the next at distance. A
//      cone has no underside at all.
//   2. The rim is LOBED, not circular. Six or seven pointed lobes give the
//      silhouette its sawtooth, which is the single cue that says "conifer" at
//      the range where nothing else about the tree survives.
//   3. The tiers DROOP. Tips below the plate's own base, so the profile is
//      slightly concave rather than a straight-sided triangle.
//
// The trunk is a separate part on the bark surface, because ART_BIBLE §4 gives
// forest bark a warm red-brown that is nothing like the canopy, and one merged
// geometry would have to pick one of them.

import type * as THREE from 'three/webgpu'
import { MeshBuilder, loft, normalize, type Vec3 } from '../mesh'
import { crossCards } from '../impostor'
import { boundsFromPoints, cylinderShape, solidCollider } from '../collider'
import { defineGenerator, type GenContext, type RawAsset } from '../generator'
import { int, num, type Params } from '../schema'

const schema = {
  height: num(12, 1.5, 34, 'Overall height including the spire.', 'm'),
  tiers: int(5, 2, 9, 'Foliage plates.'),
  spread: num(0.27, 0.08, 0.6, 'Radius of the widest plate, as a fraction of height.'),
  taper: num(1, 0.3, 2.4, 'How fast the plates shrink going up. 1 is linear.'),
  lobes: int(7, 4, 11, 'Points around the rim of a plate. This is the silhouette.'),
  notch: num(0.66, 0.35, 0.95, 'Valley radius between lobes, as a fraction of the tip.'),
  droop: num(0.15, 0, 0.6, 'How far the lobe tips hang below the plate base.'),
  lift: num(1.4, 0.4, 2.6, 'Plate height as a fraction of the gap between plates. Over 1 the plates OVERLAP.'),
  plate: num(0.11, 0.03, 0.3, 'Plate thickness as a fraction of its own radius.'),
  bare: num(0.16, 0, 0.5, 'Fraction of the trunk left clear at the bottom.'),
  trunk: num(0.042, 0.012, 0.12, 'Trunk radius as a fraction of height.'),
  lean: num(0.05, 0, 0.3, 'Trunk lean off vertical.', 'rad'),
} as const

type P = Params<typeof schema>

/** Shear about the base, so a leaning tree still meets the ground where it says. */
function warper(p: P, ctx: GenContext): (q: Vec3) => Vec3 {
  const dir = ctx.rng.range(0, Math.PI * 2)
  const kx = Math.sin(dir) * Math.tan(p.lean)
  const kz = Math.cos(dir) * Math.tan(p.lean)
  return (q) => [q[0] + kx * q[1], q[1], q[2] + kz * q[1]]
}

/**
 * One plate's rim outline: `lobes` tips alternating with valleys.
 *
 * Returned as (x, z, dy) rather than as finished points, because the plate is
 * built as a THICK slab and the same outline is needed at two heights. `dy` is
 * the droop, which hangs the tips below the plate's own base.
 */
function rimOutline(
  lobes: number, r: number, notch: number, droop: number, phase: number,
): { x: number; z: number; dy: number }[] {
  const out: { x: number; z: number; dy: number }[] = []
  for (let i = 0; i < lobes * 2; i++) {
    const tip = i % 2 === 0
    const a = phase + (i / (lobes * 2)) * Math.PI * 2
    const rr = tip ? r : r * notch
    out.push({
      x: Math.cos(a) * rr,
      z: Math.sin(a) * rr,
      dy: -(tip ? droop : droop * 0.3),
    })
  }
  return out
}

/** Profile of the whole tree: (radius, y) pairs bottom to top. For the impostor. */
export interface Tier {
  r: number
  base: number
  top: number
}

/**
 * Where every plate sits.
 *
 * `gap` is normalised by `tiers - 1 + lift` rather than by `tiers`, so the top
 * of the highest plate lands exactly on `height` even when `lift` is over 1.
 * That matters because `lift` is now over 1 BY DEFAULT: with the old 0.7 the
 * plates were 30% shorter than their own spacing, so daylight showed between
 * every pair of tiers and the tree read as a stack of separate paper party
 * hats. The reference's plates overlap — each one's rim hangs in front of the
 * one below — and that overlap is what makes the silhouette continuous.
 */
function tiersOf(p: P): Tier[] {
  const y0 = p.height * p.bare
  const span = p.height - y0
  const gap = span / Math.max(0.2, p.tiers - 1 + p.lift)
  const rMax = p.height * p.spread
  const out: Tier[] = []
  for (let t = 0; t < p.tiers; t++) {
    // `t / tiers`, NOT `t / (tiers - 1)`. Dividing by `tiers - 1` sends the top
    // plate's radius to the 8% floor — a 0.37 m needle over a 1.5 m plate on a
    // 16 m tree — and it read as a DETACHED SPIRE floating above the canopy in
    // every capture. Dividing by `tiers` leaves the top plate at a real radius,
    // so the taper ends on a small plate rather than on a spike.
    const u = t / p.tiers
    const r = rMax * Math.pow(1 - u, p.taper) + rMax * 0.14
    const base = y0 + t * gap
    // The plate's height is capped against its own RADIUS. Without the cap the
    // top plate of a 16 m tree ran 3 m tall over a 1.3 m radius — a spike, and
    // it read as a spire detached from the canopy. A plate is a plate: wider
    // than it is tall.
    out.push({ r, base, top: base + Math.min(gap * p.lift, r * 1.5) })
  }
  return out
}

/**
 * The foliage: a stack of thick, flat-bottomed, scalloped plates.
 *
 * Three things the previous version got wrong and this one fixes, all of them
 * the difference between a conifer and a party hat:
 *
 *   THICKNESS. The rim was a single edge, so a plate was an infinitely thin
 *   cone. Here the outline is emitted at two heights with a vertical wall
 *   between them — real board thickness at the rim, which is what the
 *   reference's plates have and what catches a rim light.
 *   A FLAT UNDERSIDE that is actually flat: a shallow fan up to a centre just
 *   above the rim, so the whole face takes ONE ramp stop. That face is the
 *   darkest surface on the tree and it is what separates tier from tier.
 *   A CLOSED TOP. `loft` was called without `capEnd`, which left the apex ring
 *   of every plate open — exactly 70 boundary edges on conifer-tall LOD0
 *   (14 vertices x 5 tiers), a hole in the shadow pass and in the silhouette.
 */
function foliage(
  p: P, lobes: number, rungs: 0 | 1 | 2, warp: (q: Vec3) => Vec3,
): MeshBuilder {
  const b = new MeshBuilder()
  const phi = 2.39996 // golden angle: no two plates line up their lobes
  for (const [t, tier] of tiersOf(p).entries()) {
    const { r, base, top } = tier
    const droop = r * p.droop
    const th = r * p.plate
    const phase = phi * t
    const outline = rimOutline(lobes, r, p.notch, droop, phase)
    const at = (dy: number, k: number): Vec3[] =>
      outline.map((o) => warp([o.x * k, base + o.dy + dy, o.z * k]))

    const low = at(0, 1)
    const rings: Vec3[][] = [low]
    // The rim wall. Dropped at LOD2, where a plate is a few pixels and the wall
    // is under one of them.
    if (rungs < 2) rings.push(at(th, 1))
    // The shoulder, which gives the plate its slight dome. LOD0 only.
    if (rungs === 0) rings.push(at(th + (top - base) * 0.45, 0.55))
    rings.push(at(0, 0.12).map((q) => warp([q[0], top, q[2]])))
    loft(b, rings, { closed: true, capEnd: true })

    // The flat underside. Wound so the fan faces DOWN, which is the only place
    // this face is ever seen from.
    const c = warp([0, base + th * 0.3, 0])
    for (let i = 0; i < low.length; i++) {
      b.tri(c, low[i]!, low[(i + 1) % low.length]!)
    }
  }
  return b
}

/**
 * The impostor: the tree's TIERED profile, as two crossed cards.
 *
 * Not `crossCards`, and that is the point. `silhouette2D` returns a CONVEX
 * hull, and the convex hull of a conifer is a triangle — the old impostor was
 * a plain flat triangle with no tier structure at all, so the one cue that says
 * "conifer" at distance was the first thing thrown away. This traces the actual
 * sawtooth: out to each plate's rim, back in to its apex, out again to the next.
 *
 * Normals lean UP and outward rather than off the card plane, so the cards
 * shade like the plate TOPS. The old cards splayed horizontally and landed on
 * the shadow stop while LOD0 sat on the lit one — a value jump at the switch
 * distance, which is the one artefact an impostor exists to avoid.
 */
function tieredCards(p: P, maxPoints = 6): THREE.BufferGeometry {
  const tiers = tiersOf(p)
  const profile: [number, number][] = []
  const stride = Math.max(1, Math.ceil((tiers.length * 2) / maxPoints))
  profile.push([tiers[0]!.r * 0.18, tiers[0]!.base - tiers[0]!.r * p.droop])
  for (let i = 0; i < tiers.length; i += stride) {
    const t = tiers[i]!
    profile.push([t.r, t.base - t.r * p.droop])
    profile.push([t.r * 0.3, t.top])
  }
  const last = tiers[tiers.length - 1]!
  profile.push([0.001, last.top])

  const b = new MeshBuilder()
  for (const axis of ['xy', 'zy'] as const) {
    const to3 = (x: number, y: number): Vec3 => axis === 'xy' ? [x, y, 0] : [0, y, x]
    const nrm = (x: number, side: number): Vec3 => {
      const s = Math.sign(x) || 1
      return axis === 'xy'
        ? normalize([s * 0.7, 0.62, side * 0.25])
        : normalize([side * 0.25, 0.62, s * 0.7])
    }
    for (let i = 0; i + 1 < profile.length; i++) {
      const [x0, y0] = profile[i]!
      const [x1, y1] = profile[i + 1]!
      for (const s of [1, -1]) {
        const a = to3(0, y0)
        const bb = to3(x0 * s, y0)
        const c = to3(x1 * s, y1)
        const d = to3(0, y1)
        const na = nrm(s, 1)
        // Both windings: the material is single-sided and a card seen from
        // behind must not vanish.
        b.quadN(a, na, bb, na, c, na, d, na)
        b.quadN(a, na, d, na, c, na, bb, na)
      }
    }
  }
  return b.build()
}

function trunk(p: P, sides: number, warp: (q: Vec3) => Vec3): MeshBuilder {
  const b = new MeshBuilder()
  const r0 = p.height * p.trunk
  const top = p.height * (p.bare + 0.06)
  const rings: Vec3[][] = []
  // Four courses: a root flare, the shaft, and a stub inside the lowest plate.
  const courses: [number, number][] = [[0, r0 * 1.5], [r0 * 1.2, r0], [top * 0.6, r0 * 0.8], [top, r0 * 0.5]]
  for (const [y, r] of courses) {
    const ring: Vec3[] = []
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2
      ring.push(warp([Math.cos(a) * r, y, Math.sin(a) * r]))
    }
    rings.push(ring)
  }
  loft(b, rings, { closed: true, capStart: true, capEnd: true })
  return b
}

function pointsOf(b: MeshBuilder): Vec3[] {
  const g = b.build()
  const pos = g.getAttribute('position')!
  const out: Vec3[] = []
  for (let i = 0; i < pos.count; i++) out.push([pos.getX(i), pos.getY(i), pos.getZ(i)])
  g.dispose()
  return out
}

export const conifer = defineGenerator({
  info: {
    name: 'conifer',
    slots: ['foliage', 'trunk'],
    defaultSurfaces: { foliage: 'foliage', trunk: 'bark' },
  },
  schema,
  generate(p, ctx): RawAsset {
    const warp = warper(p, ctx)
    const canopyPts = pointsOf(foliage(p, p.lobes, 0, warp))
    const trunkPts = pointsOf(trunk(p, 7, warp))
    const all = [...canopyPts, ...trunkPts]

    return {
      parts: [
        {
          slot: 'foliage',
          lods: [
            foliage(p, p.lobes, 0, warp).build(),
            foliage(p, Math.max(5, p.lobes - 2), 1, warp).build(),
            foliage(p, Math.max(4, p.lobes - 3), 2, warp).build(),
          ],
          impostor: tieredCards(p),
        },
        {
          slot: 'trunk',
          lods: [trunk(p, 7, warp).build(), trunk(p, 5, warp).build(), trunk(p, 4, warp).build()],
          impostor: crossCards(trunkPts, 0.4),
        },
      ],
      // A cylinder on the trunk, NOT a hull on the tree. The player expects to
      // drive through the canopy and to be stopped by the bole; a hull would do
      // the opposite of both.
      // Six tenths of the height, not all of it. The kart can jump, but nothing
      // it can do puts it against the top of a sixteen-metre tree, and a
      // shorter cylinder is a cheaper broad-phase.
      collider: solidCollider(cylinderShape(
        p.height * p.trunk * 1.25, p.height * 0.3, [0, p.height * 0.3, 0],
      )),
      bounds: boundsFromPoints(all),
    }
  },
})
