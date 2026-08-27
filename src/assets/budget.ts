// Triangle and draw-call accounting for the scatter set.
//
// The number that matters is not triangles, it is BATCHES. Everything here is
// instanced, so a hundred thousand tufts of grass are one draw call and a
// hundred DIFFERENT tufts are a hundred — the budget is spent on variety, not
// on density. One batch is one (asset variant, part, LOD rung) triple, because
// each one needs its own InstancedMesh.
//
// And a batch is not worth one draw call, it is worth up to five: the scene is
// drawn once for the frame and once per shadow cascade (four of them, see
// atmosphere/sunShadow.ts). That multiplier is why the ceiling below looks
// small next to the project's <1500.
//
// DELIBERATELY NOT PART OF `npm run gate`. CLAUDE.md requires every gate to be
// a subject-vs-control ratio, and a triangle budget is an absolute by nature.
// It runs as `npm run assets` instead — a build budget, not a visual gate.

import { allScatterAssets, scatterIds, scatterVariants } from './registry'
import type { AssetLod, GeneratedAsset } from './types'

/**
 * Batch ceiling for the whole scatter library.
 *
 * 160 batches is at most 160 + 4 x 128 = 672 draw calls once the shadow
 * cascades have their say (impostor batches do not cast — nothing at impostor
 * range is inside a cascade), against a 1500 budget that also has to pay for
 * terrain chunks, the kart's eleven parts, water and the sky. Half the budget
 * for scatter is generous; it is not unlimited.
 */
export const BATCH_CEILING = 160

/**
 * Triangle ceiling for one LOD0 instance, by rough class.
 *
 * Grass is the tight one and it is tight by two orders of magnitude, because it
 * is the only asset that gets instanced tens of thousands of times inside the
 * near field where LOD0 actually applies.
 */
export const TRIANGLE_CEILING: Readonly<Record<string, number>> = {
  grassTuft: 160,
  shrub: 900,
  deadwood: 700,
  rock: 400,
  conifer: 1400,
  outcrop: 2200,
}

export interface BudgetRow {
  id: string
  variant: number
  generator: string
  parts: number
  /** Triangles for one instance at LOD0, summed over parts. */
  lod0: number
  /** Same at the coarsest mesh rung. */
  lodN: number
  /** Triangles at EVERY rung, LOD0 first. The middle rungs are where the
   *  inverted ladders were hiding — see `scatterBudget`. */
  lodTriangles: number[]
  /** Local-space minimum Y at every rung, LOD0 first, then the impostor last. */
  rungFloor: number[]
  /** Worst inward-wound triangle fraction over the asset's rungs. */
  inward: number
  /** Worst fraction of a detached shell's footprint standing over nothing. */
  unsupported: number
  /** 0 when the impostor shares the coarsest rung and so costs nothing extra. */
  impostor: number
  batches: number
  footprint: number
  height: number
  colliderShapes: number
  solid: boolean
}

export interface BudgetReport {
  rows: BudgetRow[]
  defs: number
  assets: number
  batches: number
  /** Batches x (1 scene pass + 4 shadow cascades), impostors excluded. */
  worstCaseDraws: number
  problems: string[]
  ok: boolean
}

/**
 * Local-space minimum Y of a rung's geometry.
 *
 * Measured rather than trusted, because the two worst defects in the first
 * library were both invisible to any triangle count: `hullOf` seeded its start
 * box symmetrically about the origin, so every coarse rung carried a phantom
 * mirror half at exactly `-height`, and rock.ts sank its whole block below the
 * turf. Both show up instantly as a rung floor.
 */
function floorOf(lod: AssetLod): number {
  const box = lod.geometry.boundingBox
  if (box) return box.min.y
  const pos = lod.geometry.getAttribute('position')
  if (!pos) return 0
  let y = Infinity
  for (let i = 0; i < pos.count; i++) y = Math.min(y, pos.getY(i))
  return Number.isFinite(y) ? y : 0
}

/**
 * Fraction of a rung's triangles that belong to a connected component wound
 * INSIDE-OUT, by signed volume.
 *
 * The shared painterly material is single-sided, so a back-wound triangle is
 * culled and you see the far interior of the solid through the hole it leaves.
 * That is invisible to a closure check — the mesh is watertight either way —
 * and it is what made the coarse rock rungs render as hollow open wedges: all
 * six faces of `Polytope`'s start block were wound inward, and `clip` preserves
 * the winding of a face it only TRIMS while orienting just the cap it creates.
 * The defect hid at LOD0, where thirteen cut planes leave almost nothing of the
 * block (5 bad triangles of 44), and became the entire silhouette at LOD2,
 * where six planes leave most of it (18 of 32).
 *
 * SIGNED VOLUME PER COMPONENT, not a normal-versus-centroid test. A centroid
 * test only works on a single convex blob and reports 13-50% false positives on
 * everything else in this library — a stack of three outcrop courses, a conifer
 * whose tiers are separate solids, a stump plus its roots. The divergence
 * theorem is exact for any closed component however concave, and a component
 * whose volume is negligible against its own bounding box is a deliberately
 * double-wound sheet (every grass blade is emitted twice, see
 * generators/grass.ts) and is skipped rather than flagged.
 */
function inwardFraction(lod: AssetLod): number {
  const pos = lod.geometry.getAttribute('position')
  const idx = lod.geometry.getIndex()
  if (!pos || !idx || idx.count < 3) return 0
  // Union-find over vertices sharing a triangle: one set per connected shell.
  const parent = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) parent[i] = i
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r]!
    while (parent[i] !== r) { const n = parent[i]!; parent[i] = r; i = n }
    return r
  }
  // Vertices are welded on (position, normal), so a hard edge splits them. Weld
  // again on position alone here or every facet is its own component.
  const byPos = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},` +
      `${Math.round(pos.getZ(i) * 1e4)}`
    const hit = byPos.get(k)
    if (hit === undefined) byPos.set(k, i)
    else parent[find(i)] = find(hit)
  }
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const a = find(idx.getX(t))
    parent[find(idx.getX(t + 1))] = a
    parent[find(idx.getX(t + 2))] = a
  }
  interface Shell { volume: number; tris: number; min: number[]; max: number[] }
  const shells = new Map<number, Shell>()
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const root = find(idx.getX(t))
    let sh = shells.get(root)
    if (!sh) {
      sh = { volume: 0, tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      shells.set(root, sh)
    }
    sh.tris++
    for (let k = 0; k < 3; k++) {
      const i = idx.getX(t + k)
      const p = [pos.getX(i), pos.getY(i), pos.getZ(i)]
      for (let ax = 0; ax < 3; ax++) {
        sh.min[ax] = Math.min(sh.min[ax]!, p[ax]!)
        sh.max[ax] = Math.max(sh.max[ax]!, p[ax]!)
      }
    }
    const ia = idx.getX(t)
    const ib = idx.getX(t + 1)
    const ic = idx.getX(t + 2)
    // Six times the signed volume of the tetrahedron (origin, a, b, c).
    sh.volume +=
      pos.getX(ia) * (pos.getY(ib) * pos.getZ(ic) - pos.getZ(ib) * pos.getY(ic)) -
      pos.getY(ia) * (pos.getX(ib) * pos.getZ(ic) - pos.getZ(ib) * pos.getX(ic)) +
      pos.getZ(ia) * (pos.getX(ib) * pos.getY(ic) - pos.getY(ib) * pos.getX(ic))
  }
  let bad = 0
  let total = 0
  for (const sh of shells.values()) {
    total += sh.tris
    const box = (sh.max[0]! - sh.min[0]!) * (sh.max[1]! - sh.min[1]!) * (sh.max[2]! - sh.min[2]!)
    // |V| under 2% of the bounding box is a sheet, not a solid.
    if (Math.abs(sh.volume / 6) < Math.max(1e-9, box * 0.02)) continue
    if (sh.volume < 0) bad += sh.tris
  }
  return total === 0 ? 0 : bad / total
}

/**
 * Largest fraction of any detached shell's footprint that sits over NOTHING.
 *
 * The `floats` check above is a per-ASSET bbox test and is structurally blind to
 * this: a stack whose middle course hangs 4.6 m off the end of the one below
 * still has its bounding box on the ground. cliff-block shipped exactly that --
 * 25.9% of its top course over open air, with green ground visible THROUGH the
 * silhouette in shots/forge/forge-close-cliff-block.png at two places.
 *
 * Area, not bounding-box overlap. The first version of this test asked whether a
 * shell's AABB overlapped one below it at all, and passed the broken cliff-block
 * cleanly -- the two courses did overlap, just not under the part that was
 * hanging. Coverage is sampled on a grid inside the shell's own footprint hull.
 */
function unsupportedFraction(lod: AssetLod): number {
  const pos = lod.geometry.getAttribute('position')
  const idx = lod.geometry.getIndex()
  if (!pos || !idx || idx.count < 3) return 0
  // WELD BY POSITION FIRST. Vertices are welded on (position, normal), so a hard
  // edge splits them and a raw index union-find makes every FACET its own
  // component -- which turns this test into noise. `inwardFraction` above has
  // the same guard for the same reason.
  const byPos = new Map<string, number>()
  const rep = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},` +
      `${Math.round(pos.getZ(i) * 1e4)}`
    const hit = byPos.get(k)
    if (hit === undefined) { byPos.set(k, i); rep[i] = i } else rep[i] = hit
  }
  const parent = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) parent[i] = rep[i]!
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r]!
    while (parent[i] !== r) { const n = parent[i]!; parent[i] = r; i = n }
    return r
  }
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const a = find(rep[idx.getX(t)]!)
    parent[find(rep[idx.getX(t + 1)]!)] = a
    parent[find(rep[idx.getX(t + 2)]!)] = a
  }
  const shells = new Map<number, { pts: [number, number][]; y0: number; y1: number }>()
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const root = find(rep[idx.getX(t)]!)
    let sh = shells.get(root)
    if (!sh) { sh = { pts: [], y0: Infinity, y1: -Infinity }; shells.set(root, sh) }
    for (let k = 0; k < 3; k++) {
      const i = idx.getX(t + k)
      sh.pts.push([pos.getX(i), pos.getZ(i)])
      sh.y0 = Math.min(sh.y0, pos.getY(i))
      sh.y1 = Math.max(sh.y1, pos.getY(i))
    }
  }
  const list = [...shells.values()].map((sh) => ({ ...sh, foot: hull2d(sh.pts) }))
  if (list.length < 2) return 0
  let worst = 0
  for (const sh of list) {
    // A shell reaching the ground is supported by the ground.
    if (sh.y0 < 0.05 || sh.foot.length < 3) continue
    const below = list.filter((o) =>
      o !== sh && o.y0 < sh.y0 - 1e-6 && o.y1 > sh.y0 - 1e-6 && o.foot.length >= 3)
    const xs = sh.foot.map((q) => q[0])
    const zs = sh.foot.map((q) => q[1])
    const x0 = Math.min(...xs); const x1 = Math.max(...xs)
    const z0 = Math.min(...zs); const z1 = Math.max(...zs)
    let tot = 0; let un = 0
    const N = 64
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const q: [number, number] = [
          x0 + (x1 - x0) * (i + 0.5) / N,
          z0 + (z1 - z0) * (j + 0.5) / N,
        ]
        if (!inHull(sh.foot, q)) continue
        tot++
        if (!below.some((o) => inHull(o.foot, q))) un++
      }
    }
    if (tot > 0) worst = Math.max(worst, un / tot)
  }
  return worst
}

/** Convex hull in XZ, counter-clockwise (monotone chain). */
function hull2d(pts: readonly [number, number][]): [number, number][] {
  if (pts.length < 3) return []
  const p = [...pts].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src: [number, number][]): [number, number][] => {
    const out: [number, number][] = []
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

function inHull(h: readonly [number, number][], p: readonly [number, number]): boolean {
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!
    const b = h[(i + 1) % h.length]!
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < -1e-9) return false
  }
  return true
}

function rowOf(a: GeneratedAsset): BudgetRow {
  let lod0 = 0
  let lodN = 0
  let impostor = 0
  let batches = 0
  const rungs = Math.max(...a.parts.map((p) => p.lods.length), 1)
  const lodTriangles = new Array<number>(rungs).fill(0)
  const rungFloor = new Array<number>(rungs + 1).fill(Infinity)
  let inward = 0
  let unsupported = 0
  for (const p of a.parts) {
    lod0 += p.lods[0]?.triangles ?? 0
    lodN += p.lods[p.lods.length - 1]?.triangles ?? 0
    impostor += p.impostorShared ? 0 : p.impostor.triangles
    batches += p.lods.length + (p.impostorShared ? 0 : 1)
    p.lods.forEach((l, i) => {
      lodTriangles[i] = (lodTriangles[i] ?? 0) + l.triangles
      rungFloor[i] = Math.min(rungFloor[i]!, floorOf(l))
    })
    rungFloor[rungs] = Math.min(rungFloor[rungs]!, floorOf(p.impostor))
    for (const l of p.lods) inward = Math.max(inward, inwardFraction(l))
    for (const l of p.lods) unsupported = Math.max(unsupported, unsupportedFraction(l))
  }
  return {
    id: a.id,
    variant: a.variant,
    generator: a.generator,
    parts: a.parts.length,
    lod0,
    lodN,
    lodTriangles,
    rungFloor: rungFloor.map((v) => Number.isFinite(v) ? v : 0),
    inward,
    unsupported,
    impostor,
    batches,
    footprint: a.bounds.footprint,
    height: a.bounds.height,
    colliderShapes: a.collider.shapes.length,
    solid: a.collider.solid,
  }
}

export function scatterBudget(): BudgetReport {
  const assets = allScatterAssets()
  const rows = assets.map(rowOf)
  const problems: string[] = []

  let batches = 0
  let impostorBatches = 0
  for (const a of assets) {
    for (const p of a.parts) {
      batches += p.lods.length + (p.impostorShared ? 0 : 1)
      if (!p.impostorShared) impostorBatches += 1
    }
  }

  for (const r of rows) {
    const cap = TRIANGLE_CEILING[r.generator]
    if (cap !== undefined && r.lod0 > cap) {
      problems.push(`${r.id}#${r.variant}: ${r.lod0} tris at LOD0, ceiling ${cap}`)
    }
    // A ladder that does not actually get cheaper is a ladder that is costing
    // batches for nothing.
    //
    // PAIRWISE, over every adjacent pair. The old check compared the LAST rung
    // against the FIRST and skipped every rung in between, which is exactly
    // where the failure lived: eight of thirty-two baked variants had an LOD1
    // costing 2.4-3.0x their LOD0 (cliff-block 76 -> 186, outcrop-step
    // 84 -> 256, shrub-broadleaf 100 -> 239) and `npm run assets` printed
    // "assets ok" throughout, because rung 2 was cheaper than rung 0 and that
    // was the whole test. This is a per-asset INVARIANT — each rung strictly
    // cheaper than the one before — not a tuned threshold, so it does not
    // conflict with CLAUDE.md's subject-vs-control rule for the visual gates.
    for (let i = 1; i < r.lodTriangles.length; i++) {
      const prev = r.lodTriangles[i - 1]!
      const cur = r.lodTriangles[i]!
      if (cur >= prev) {
        problems.push(
          `${r.id}#${r.variant}: LOD${i} (${cur} tris) is not cheaper than ` +
          `LOD${i - 1} (${prev}) — an inverted ladder costs batches to run slower`,
        )
      }
    }
    // NO RUNG MAY DIP BELOW LOD0'S BASE. A coarse rung is allowed to be bigger
    // than LOD0 — dropping cut planes can only grow a solid — but growing
    // DOWNWARD puts geometry under the terrain where it can only ever be
    // invisible or, worse, poke through a slope below. This one check catches
    // every mirrored hull at once.
    const base = r.rungFloor[0] ?? 0
    const span = Math.max(0.05, r.height)
    for (let i = 1; i < r.rungFloor.length; i++) {
      if ((r.rungFloor[i] ?? 0) < base - span * 0.08) {
        problems.push(
          `${r.id}#${r.variant}: ${i === r.rungFloor.length - 1 ? 'impostor' : `LOD${i}`} ` +
          `floor ${r.rungFloor[i]!.toFixed(3)} m dips below LOD0's ${base.toFixed(3)} m`,
        )
      }
    }
    // GROUND CONTACT. Assets are authored with their base at y = 0 and the world
    // places them on the terrain surface, so a positive floor is an asset
    // hovering and a very negative one is an asset buried. Both shipped.
    if (base > span * 0.02) {
      problems.push(
        `${r.id}#${r.variant}: floats — lowest geometry is ${base.toFixed(3)} m above y=0`,
      )
    }
    if (base < -span * 0.62) {
      problems.push(
        `${r.id}#${r.variant}: buried — ${(-base / span * 100).toFixed(0)}% of its ` +
        `${span.toFixed(2)} m height is below y=0`,
      )
    }
    if (r.impostor > r.lodN) {
      problems.push(
        `${r.id}#${r.variant}: impostor (${r.impostor}) costs more than the coarsest rung ` +
        `(${r.lodN}) — either make it cheaper or share the rung`,
      )
    }
    // The world team's hard dependency. A solid asset with no shapes cannot be
    // collided and would be silently driven through.
    if (r.solid && r.colliderShapes === 0) {
      problems.push(`${r.id}#${r.variant}: marked solid but has no collision shapes`)
    }
    // Zero tolerance: signed volume has no false positives to absorb. A shell is
    // either wound outward or it is not.
    if (r.inward > 0.001) {
      problems.push(
        `${r.id}#${r.variant}: ${(r.inward * 100).toFixed(0)}% of triangles belong to a ` +
        `shell wound INSIDE-OUT — a single-sided material culls them and the form ` +
        `renders hollow`,
      )
    }
    // SCOPED TO STACKED MASSES, and the exclusion is the interesting part.
    //
    // Applied to every asset this reads a conifer as 100% unsupported: the
    // canopy is a separate shell from the trunk, and a tier's footprint is much
    // wider than the stick holding it up, so almost none of it stands over
    // geometry. That is correct for a tree and wrong for a rock, and no
    // threshold separates them -- the conifer scores WORSE (100%) than the
    // genuinely broken cliff-block did (26%).
    //
    // What is being asserted is a property of the outcrop form language rather
    // than of all geometry: a stratified rock mass is self-supporting, each
    // course resting on the one below. A canopy overhanging a trunk is not a
    // defect. If another generator starts stacking courses, add it here.
    //
    // 5%: a hull footprint slightly overshoots the solid it wraps, so a course
    // that IS supported can measure a couple of percent over air at the corners.
    // The real failures were 26% (cliff-block) and 35% (outcrop-step).
    if (r.generator === 'outcrop' && r.unsupported > 0.05) {
      problems.push(
        `${r.id}#${r.variant}: ${(r.unsupported * 100).toFixed(0)}% of a detached shell's ` +
        `footprint stands over nothing — the piece floats, and the per-asset ` +
        `floats check cannot see it because the stack's bbox is still on the ground`,
      )
    }
    if (r.footprint <= 0 || r.height <= 0) {
      problems.push(`${r.id}#${r.variant}: degenerate bounds`)
    }
  }
  if (batches > BATCH_CEILING) {
    problems.push(`scatter set is ${batches} batches, ceiling ${BATCH_CEILING}`)
  }

  return {
    rows,
    defs: scatterIds().length,
    assets: assets.length,
    batches,
    worstCaseDraws: batches + (batches - impostorBatches) * 4,
    problems,
    ok: problems.length === 0,
  }
}

/** Variant counts per def, for the report header. */
export function variantCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id of scatterIds()) out[id] = scatterVariants(id)
  return out
}
