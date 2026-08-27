// The scatter registry: JSON defs in, built assets out.
//
// CLAUDE.md: "No hardcoded assets. Every asset is a JSON def in assets/defs/
// driven by a Forge generator." This is the loader half of that for scatter,
// and it is deliberately the same shape as `material/defs.ts` is for surfaces —
// eager glob at build time so there is no async load to race `__ready` against,
// strict validation so a typo fails loudly, and one registry the Forge (M5) can
// later write back into.
//
// VARIANTS are the one idea here that is not obvious. Scatter needs variety and
// instancing needs sameness, and those pull against each other: jittering
// geometry per instance would give every rock its own draw call. So a def
// declares a small number of variants, the registry bakes each one ONCE, and
// the world picks a variant per instance and batches by it. Variety costs draw
// calls linearly and you can see the price in `budget.ts`, which is the right
// way round — the alternative hides the cost until the frame budget blows.

import { Rng, hashSeed } from '../core/rng'
import { surface, surfaceIds } from '../material/defs'
import { PAINTERLY_DEFAULTS, type PainterlyParams } from '../material/painterly'
import { triangleCount } from './mesh'
import type { AnyGenerator } from './generator'
import type { AssetLod, AssetPart, GeneratedAsset } from './types'
import { conifer } from './generators/conifer'
import { deadwood } from './generators/deadwood'
import { grassTuft } from './generators/grass'
import { outcrop } from './generators/outcrop'
import { rock } from './generators/rock'
import { shrub } from './generators/shrub'

const GENERATORS: readonly AnyGenerator[] = [conifer, deadwood, grassTuft, outcrop, rock, shrub]

const BY_NAME = new Map<string, AnyGenerator>()
for (const g of GENERATORS) {
  if (BY_NAME.has(g.info.name)) throw new Error(`duplicate generator: ${g.info.name}`)
  BY_NAME.set(g.info.name, g)
}

export interface ScatterDef {
  id: string
  version: number
  type: string
  generator: string
  notes?: string
  params?: Record<string, unknown>
  /** Slot -> painterly surface def id. Omitted slots take the generator default. */
  surfaces?: Record<string, string>
  /**
   * Slot -> per-asset overrides on top of that surface's def.
   *
   * ARCHITECTURE's example def carries a `material` block for exactly this. It
   * is not a second palette: colours stay in the shared surface def so a biome
   * repaint reaches every asset at once. What belongs here is the handful of
   * params that depend on the FORM rather than on the palette — `ambient` on a
   * form whose facets need to separate, `gradientStrength` on a form whose
   * sweep the shared def assumed was a unit cube.
   */
  material?: Record<string, Record<string, string | number>>
  lod?: {
    /**
     * Metres at which each LOD hands over to the next. One entry per rung; the
     * last one is where the impostor takes over. Derived from the asset's own
     * size when omitted, which is almost always the right answer.
     */
    switch?: number[]
  }
  /** How many baked geometry variants to build. 1 means no variation. */
  variants?: number
  /** Param -> relative jitter for variants past the first. */
  seedJitter?: Record<string, number>
  biomes?: string[]
}

/**
 * Default LOD ladder, as multiples of the asset's bounding radius.
 *
 * Size-relative rather than absolute, because the same numbers have to serve a
 * 0.2 m pebble and a 30 m outcrop: a fixed 40 m switch would put the pebble on
 * its impostor while it is still a metre from the camera, and would keep the
 * outcrop at LOD0 across the whole valley. The multipliers are set so a form
 * swaps down when it is roughly 60, 22 and 8 pixels of screen height at the
 * game's 58 degree vertical FOV on a 1080p frame.
 */
const LOD_STEPS = [16, 46, 130] as const

const modules = import.meta.glob<{ default: ScatterDef }>(
  '/assets/defs/scatter/*.json', { eager: true },
)

const DEFS = new Map<string, ScatterDef>()
for (const mod of Object.values(modules)) {
  const def = mod.default
  if (def.type !== 'scatter') continue
  if (DEFS.has(def.id)) throw new Error(`duplicate scatter def id: ${def.id}`)
  validate(def)
  DEFS.set(def.id, def)
}

function validate(def: ScatterDef): void {
  const gen = BY_NAME.get(def.generator)
  if (!gen) {
    throw new Error(
      `${def.id}: no generator "${def.generator}" ` +
      `(have: ${[...BY_NAME.keys()].sort().join(', ')})`,
    )
  }
  const known = new Set(surfaceIds())
  for (const [slot, surface] of Object.entries(def.surfaces ?? {})) {
    if (!gen.info.slots.includes(slot)) {
      throw new Error(
        `${def.id}.surfaces.${slot}: generator "${def.generator}" has no such slot ` +
        `(have: ${gen.info.slots.join(', ')})`,
      )
    }
    if (!known.has(surface)) {
      throw new Error(`${def.id}.surfaces.${slot}: no surface def "${surface}"`)
    }
  }
  // Every slot must resolve, or a part would render with the wrong palette and
  // nothing would say so.
  for (const slot of gen.info.slots) {
    const s = def.surfaces?.[slot] ?? gen.info.defaultSurfaces[slot]
    if (!s || !known.has(s)) {
      throw new Error(`${def.id}: slot "${slot}" resolves to no known surface`)
    }
  }
  for (const slot of Object.keys(def.material ?? {})) {
    if (!gen.info.slots.includes(slot)) {
      throw new Error(
        `${def.id}.material.${slot}: generator "${def.generator}" has no such slot ` +
        `(have: ${gen.info.slots.join(', ')})`,
      )
    }
  }
  for (const key of Object.keys(def.seedJitter ?? {})) {
    const spec = gen.schema[key]
    if (!spec) throw new Error(`${def.id}.seedJitter.${key}: not a param of "${def.generator}"`)
    if (spec.kind !== 'number' && spec.kind !== 'int') {
      throw new Error(`${def.id}.seedJitter.${key}: only numeric params can be jittered`)
    }
  }
  const v = def.variants ?? 1
  if (!Number.isInteger(v) || v < 1 || v > 6) {
    throw new Error(`${def.id}.variants: expected an integer 1..6, got ${String(def.variants)}`)
  }
}

const COLOUR_KEYS = new Set(['base', 'shadow', 'lit', 'top'])

/**
 * Resolve a slot to painterly params: named surface, gradient rescaled to the
 * asset's own height, then the def's overrides.
 *
 * The rescale is the part that is easy to miss and impossible to see until it
 * is wrong. `gradientBase` and `gradientHeight` in a surface def are OBJECT
 * space, and every existing def says so in its notes — they were authored
 * against the greybox, where geometry is unit-sized and the instance matrix
 * carries the scale. This library authors in METRES, because a collision proxy
 * and an LOD switch distance are both meaningless without real units. Reusing
 * `gradientHeight: 1` on a 15 m conifer would saturate the sweep inside the
 * first metre of trunk and switch off the vertical gradient for the whole tree
 * — which ART_BIBLE §3 calls out as doing "enormous work in the Genshin and
 * Capy references".
 *
 * Bucketed to powers of two so forty assets cannot become forty materials and
 * forty pipeline compiles. Within a bucket the sweep is at most a factor of two
 * long, which is invisible.
 */
function resolveMaterial(
  defId: string, surfaceId: string, height: number,
  overrides: Readonly<Record<string, string | number>> | undefined,
): PainterlyParams {
  const bucket = Math.min(32, Math.max(0.5, 2 ** Math.ceil(Math.log2(Math.max(0.25, height)))))
  const out: PainterlyParams = {
    ...surface(surfaceId),
    // Assets are authored with their base at y = 0, so the sweep starts there
    // and runs over the form's own height.
    gradientBase: 0,
    gradientHeight: bucket,
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in PAINTERLY_DEFAULTS)) {
      throw new Error(`${defId}.material.${key}: not a PainterlyParams key`)
    }
    if (COLOUR_KEYS.has(key)) {
      if (typeof value === 'number') {
        ;(out as unknown as Record<string, number>)[key] = value
        continue
      }
      const m = /^#([0-9a-fA-F]{6})$/.exec(value)
      if (!m?.[1]) {
        throw new Error(`${defId}.material.${key}: expected "#rrggbb", got ${JSON.stringify(value)}`)
      }
      ;(out as unknown as Record<string, number>)[key] = parseInt(m[1], 16)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${defId}.material.${key}: expected a number, got ${JSON.stringify(value)}`)
    }
    ;(out as unknown as Record<string, number>)[key] = value
  }
  return out
}

function jittered(
  def: ScatterDef, gen: AnyGenerator, variant: number, rng: Rng,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(def.params ?? {}) }
  // Variant 0 is always the def exactly as authored, so the Forge shows what
  // was written and a param change is visible without hunting for the variant
  // it landed on.
  if (variant === 0) return out
  for (const [key, amount] of Object.entries(def.seedJitter ?? {})) {
    const spec = gen.schema[key]
    if (!spec || (spec.kind !== 'number' && spec.kind !== 'int')) continue
    const base = typeof out[key] === 'number' ? out[key] as number : spec.default
    const v = base * (1 + rng.range(-amount, amount))
    out[key] = spec.kind === 'int' ? Math.round(v) : v
  }
  return out
}

const CACHE = new Map<string, GeneratedAsset>()

export function scatterIds(): string[] {
  return [...DEFS.keys()].sort()
}

export function scatterDef(id: string): ScatterDef {
  const def = DEFS.get(id)
  if (!def) throw new Error(`no scatter def "${id}" (have: ${scatterIds().join(', ')})`)
  return def
}

export function scatterVariants(id: string): number {
  return scatterDef(id).variants ?? 1
}

/** Build (or return the cached) asset. Deterministic in (id, variant). */
export function scatterAsset(id: string, variant = 0): GeneratedAsset {
  const key = `${id}#${variant}`
  const hit = CACHE.get(key)
  if (hit) return hit
  const def = scatterDef(id)
  const gen = BY_NAME.get(def.generator)!
  const count = def.variants ?? 1
  if (variant < 0 || variant >= count) {
    throw new Error(`${id}: variant ${variant} out of range 0..${count - 1}`)
  }
  // Seeded from the def id and the variant index and nothing else — no shared
  // stream, so adding a def cannot shift every other asset in the library.
  const rng = new Rng(hashSeed(`${id}#${variant}`))
  const raw = gen.generate(jittered(def, gen, variant, rng), { id: key, variant, rng })

  const steps = def.lod?.switch
  const parts: AssetPart[] = raw.parts.map((part) => {
    const surfaceId = def.surfaces?.[part.slot] ?? gen.info.defaultSurfaces[part.slot]!
    const lods: AssetLod[] = part.lods.map((geometry, i) => ({
      geometry,
      triangles: triangleCount(geometry),
      until: steps?.[i] ?? raw.bounds.radius * (LOD_STEPS[i] ?? LOD_STEPS[LOD_STEPS.length - 1]!),
    }))
    const shared = part.impostor === part.lods[part.lods.length - 1]
    return {
      slot: part.slot,
      surface: surfaceId,
      material: resolveMaterial(id, surfaceId, raw.bounds.height, def.material?.[part.slot]),
      lods,
      impostor: shared
        ? { ...lods[lods.length - 1]!, until: Infinity }
        : {
          geometry: part.impostor,
          triangles: triangleCount(part.impostor),
          until: Infinity,
        },
      impostorShared: shared,
    }
  })
  const asset: GeneratedAsset = {
    id,
    generator: def.generator,
    variant,
    parts,
    collider: raw.collider,
    bounds: raw.bounds,
    triangles: parts.reduce((n, p) => n + (p.lods[0]?.triangles ?? 0), 0),
  }
  CACHE.set(key, asset)
  return asset
}

/** Every variant of every def. The thing budgets and the Forge iterate. */
export function allScatterAssets(): GeneratedAsset[] {
  const out: GeneratedAsset[] = []
  for (const id of scatterIds()) {
    for (let v = 0; v < scatterVariants(id); v++) out.push(scatterAsset(id, v))
  }
  return out
}

/** Every generator, for the Forge's param panel. */
export function generators(): readonly AnyGenerator[] {
  return GENERATORS
}

/**
 * Which rung to draw at a given camera distance. `-1` means the impostor.
 *
 * The world's LOD selection lives in the vegetation cull compute pass (render
 * graph step 5); this is the same decision in CPU form, for the Forge and for
 * any CPU-side scatter that has not moved onto the GPU yet.
 */
export function pickLod(part: AssetPart, distance: number): number {
  for (let i = 0; i < part.lods.length; i++) {
    if (distance < part.lods[i]!.until) return i
  }
  return -1
}
