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

import { MeshBuilder, loft, type Vec3 } from '../mesh'
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
  lift: num(0.7, 0.15, 1.1, 'Plate height as a fraction of the gap between plates.'),
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

/** One plate's rim: `lobes` tips alternating with valleys, tips hanging low. */
function rim(lobes: number, r: number, y: number, notch: number, droop: number, phase: number): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < lobes * 2; i++) {
    const tip = i % 2 === 0
    const a = phase + (i / (lobes * 2)) * Math.PI * 2
    const rr = tip ? r : r * notch
    out.push([Math.cos(a) * rr, y - (tip ? droop : droop * 0.35), Math.sin(a) * rr])
  }
  return out
}

function foliage(p: P, lobes: number, midRing: boolean, warp: (q: Vec3) => Vec3): MeshBuilder {
  const b = new MeshBuilder()
  const y0 = p.height * p.bare
  const span = p.height - y0
  const gap = span / p.tiers
  const plateH = gap * p.lift
  const rMax = p.height * p.spread
  const phi = 2.39996 // golden angle: no two plates line up their lobes
  for (let t = 0; t < p.tiers; t++) {
    const u = t / Math.max(1, p.tiers - 1)
    const r = rMax * Math.pow(1 - u, p.taper) + rMax * 0.06
    const base = y0 + t * gap
    const droop = r * p.droop
    const phase = phi * t
    const rings: Vec3[][] = [rim(lobes, r, base, p.notch, droop, phase)]
    if (midRing) rings.push(rim(lobes, r * 0.58, base + plateH * 0.5, p.notch * 1.25, 0, phase))
    rings.push(rim(lobes, r * 0.13, base + plateH, 1, 0, phase))
    loft(b, rings.map((ring) => ring.map(warp)), { closed: true })
    // The flat underside, as a shallow fan to a point just under the plate.
    // This is the darkest face on the tree and the reason the tiers separate.
    const under = rings[0]!.map(warp)
    const c = warp([0, base - droop * 0.35, 0])
    // Wound so the fan faces DOWN. The other winding is culled from below,
    // which is the only place this face is ever seen from.
    for (let i = 0; i < under.length; i++) {
      b.tri(c, under[i]!, under[(i + 1) % under.length]!)
    }
  }
  return b
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
    const canopyPts = pointsOf(foliage(p, p.lobes, true, warp))
    const trunkPts = pointsOf(trunk(p, 7, warp))
    const all = [...canopyPts, ...trunkPts]

    return {
      parts: [
        {
          slot: 'foliage',
          lods: [
            foliage(p, p.lobes, true, warp).build(),
            foliage(p, Math.max(4, p.lobes - 2), false, warp).build(),
            foliage(p, Math.max(3, p.lobes - 4), false, warp).build(),
          ],
          // 0.75 splay: the two cards must not flip value against each other as
          // the sun crosses them, which is the tell that gives a billboard away.
          impostor: crossCards(canopyPts, 0.75),
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
