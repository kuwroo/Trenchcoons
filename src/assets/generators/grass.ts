// Grass tufts and blade clusters.
//
// The renderer instances these — tens of thousands of them — so this is the one
// generator where the triangle count per asset is a real budget rather than a
// rounding error, and every decision below is that budget arguing with the
// silhouette.
//
// Three of them are worth stating outright:
//
// SINGLE-SIDED BLADES ARE NOT AN OPTION. The shared painterly material is
// `MeshBasicNodeMaterial` with default front-face culling, so a flat blade
// simply DISAPPEARS from behind — and a tuft is seen from behind exactly half
// the time. Every blade is therefore emitted twice, once per winding, sharing
// one vertex set through the builder's weld. Twelve triangles a blade, not six.
//
// BOTH WINDINGS SHARE THE SAME NORMAL, and it is not the face normal. It is
// blended toward the tuft's outward radial and toward up, which turns a tuft
// from a heap of independently-flickering cards into one soft dome that takes a
// single ramp stop. That hemispherical-normal trick is what makes stylised
// grass read as a lawn instead of as confetti, and it costs nothing.
//
// NO WIND ATTRIBUTE. When the global wind field lands (render graph step 2)
// vegetation displaces by height along the blade — and that weight is already
// available to the shader as `positionLocal.y` over the asset's height, so
// there is nothing to author and nothing to carry. An extra attribute here
// would be dead weight in every instance buffer in the game.

import { MeshBuilder, normalize, type Vec3 } from '../mesh'
import { billboard } from '../impostor'
import { boundsFromPoints, noCollision } from '../collider'
import { defineGenerator, type GenContext, type RawAsset } from '../generator'
import { int, num, type Params } from '../schema'

const schema = {
  height: num(0.42, 0.06, 1.8, 'Blade length.', 'm'),
  blades: int(9, 1, 24, 'Blades in the tuft.'),
  width: num(0.032, 0.004, 0.14, 'Blade width at the base.', 'm'),
  bend: num(0.85, 0.05, 2, 'Total arc of a blade, base to tip.', 'rad'),
  fan: num(0.09, 0, 0.9, 'Radius the blade bases are spread over.', 'm'),
  vary: num(0.38, 0, 0.9, 'Spread of blade heights within the tuft.'),
  splay: num(0.55, 0, 1, 'How far vertex normals lean outward from the tuft axis.'),
  lift: num(0.62, 0, 1, 'How far vertex normals lean toward straight up.'),
} as const

type P = Params<typeof schema>

function blade(
  b: MeshBuilder, p: P, segs: number,
  cx: number, cz: number, yaw: number, len: number, bend: number, w: number,
): void {
  const dirX = Math.cos(yaw)
  const dirZ = Math.sin(yaw)
  // Perpendicular in the ground plane: the blade's width axis.
  const perpX = -dirZ
  const perpZ = dirX
  const k = len / Math.max(0.05, bend)

  // The vertex normal. Constant along the blade and shared by both windings —
  // see the header. `radial` is the direction from the tuft's own axis, so the
  // outside of the tuft catches the key and the inside falls into the mid stop.
  const rl = Math.hypot(cx, cz)
  const radial: Vec3 = rl < 1e-5 ? [dirX, 0, dirZ] : [cx / rl, 0, cz / rl]
  const n = normalize([
    radial[0] * p.splay + dirX * (1 - p.splay) * 0.25,
    p.lift + 0.35,
    radial[2] * p.splay + dirZ * (1 - p.splay) * 0.25,
  ])

  const at = (t: number, side: number): Vec3 => {
    const ang = t * bend
    const up = k * Math.sin(ang)
    const out = k * (1 - Math.cos(ang))
    // Taper with a slight shoulder rather than a straight triangle: a blade
    // that narrows linearly reads as a spike, and the reference's grass is
    // strappy.
    const hw = w * 0.5 * (1 - Math.pow(t, 1.6))
    return [
      cx + dirX * out + perpX * hw * side,
      up,
      cz + dirZ * out + perpZ * hw * side,
    ]
  }

  for (let s = 0; s < segs; s++) {
    const t0 = s / segs
    const t1 = (s + 1) / segs
    const a = at(t0, -1)
    const bb = at(t0, 1)
    if (t1 >= 1) {
      // The tip is a POINT, so the last span is a triangle. Emitting it as a
      // quad — which the first version did — makes both of its far corners the
      // same vertex, and every blade in the game then carries two zero-area
      // triangles. On a tuft that is instanced tens of thousands of times that
      // is a sixth of the grass budget spent on nothing.
      const tip = at(1, 0)
      b.triN(a, n, bb, n, tip, n)
      b.triN(a, n, tip, n, bb, n)
      break
    }
    const c = at(t1, 1)
    const d = at(t1, -1)
    b.quadN(a, n, bb, n, c, n, d, n)
    b.quadN(a, n, d, n, c, n, bb, n)
  }
}

interface Blade {
  cx: number
  cz: number
  yaw: number
  len: number
  bend: number
  w: number
}

/**
 * The tuft's blades, drawn once.
 *
 * Every rung of the ladder renders a PREFIX of this list, never a fresh draw.
 * Re-rolling per rung was the first version and it is wrong in a way that only
 * shows in motion: the clump appears to jump sideways at the switch distance,
 * because LOD1 was a different tuft rather than the same one with fewer blades.
 * Radius is indexed against the full blade count for the same reason.
 */
function bladeSet(p: P, ctx: GenContext): Blade[] {
  const rng = ctx.rng.fork('tuft')
  const out: Blade[] = []
  for (let i = 0; i < p.blades; i++) {
    // Golden-angle placement, so even three blades spread instead of clumping.
    const a = i * 2.39996 + rng.range(-0.4, 0.4)
    const r = p.fan * Math.sqrt((i + 0.5) / p.blades)
    out.push({
      cx: Math.cos(a) * r,
      cz: Math.sin(a) * r,
      yaw: a + rng.range(-0.5, 0.5),
      len: p.height * (1 - p.vary * 0.5 + rng.float() * p.vary),
      bend: p.bend * rng.range(0.7, 1.3),
      w: p.width * rng.range(0.75, 1.2),
    })
  }
  // Tallest first, so a prefix keeps the blades that carry the silhouette.
  return out.sort((x, y) => y.len - x.len)
}

function tuft(p: P, blades: readonly Blade[], count: number, segs: number): MeshBuilder {
  const b = new MeshBuilder()
  for (let i = 0; i < Math.min(count, blades.length); i++) {
    const d = blades[i]!
    blade(b, p, segs, d.cx, d.cz, d.yaw, d.len, d.bend, d.w)
  }
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

export const grassTuft = defineGenerator({
  info: { name: 'grassTuft', slots: ['body'], defaultSurfaces: { body: 'grassMound' } },
  schema,
  generate(p, ctx): RawAsset {
    const blades = bladeSet(p, ctx)
    const lod0 = tuft(p, blades, p.blades, 3)
    const lod1 = tuft(p, blades, Math.max(2, Math.round(p.blades * 0.45)), 2)
    const lod2 = tuft(p, blades, Math.max(1, Math.round(p.blades * 0.2)), 1)
    const pts = pointsOf(tuft(p, blades, p.blades, 3))
    return {
      parts: [{
        slot: 'body',
        lods: [lod0.build(), lod1.build(), lod2.build()],
        // One card from the tuft's bounds, not two from its outline. At the
        // range grass swaps to an impostor it is a few pixels of green; a
        // crossed pair would cost more than the two-blade rung it replaces,
        // which would make the impostor pointless.
        impostor: billboard(pts, 0.5),
      }],
      collider: noCollision(),
      bounds: boundsFromPoints(pts),
    }
  },
})
