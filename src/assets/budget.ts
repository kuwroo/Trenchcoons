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
import type { GeneratedAsset } from './types'

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

function rowOf(a: GeneratedAsset): BudgetRow {
  let lod0 = 0
  let lodN = 0
  let impostor = 0
  let batches = 0
  for (const p of a.parts) {
    lod0 += p.lods[0]?.triangles ?? 0
    lodN += p.lods[p.lods.length - 1]?.triangles ?? 0
    impostor += p.impostorShared ? 0 : p.impostor.triangles
    batches += p.lods.length + (p.impostorShared ? 0 : 1)
  }
  return {
    id: a.id,
    variant: a.variant,
    generator: a.generator,
    parts: a.parts.length,
    lod0,
    lodN,
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
    if (r.lodN >= r.lod0) {
      problems.push(`${r.id}#${r.variant}: coarsest rung (${r.lodN}) is not cheaper than LOD0 (${r.lod0})`)
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
