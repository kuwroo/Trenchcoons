// Asset definitions — the loader half of the M1 deliverable.
//
// CLAUDE.md: "No hardcoded assets. Every asset is a JSON def in assets/defs/."
// MILESTONES M1: "Asset definition format + loader (no UI yet)", and the second
// ordering principle: "the asset definition format exists from M1. Even before
// the Forge UI is built, nothing is ever hardcoded."
//
// Round 1 shipped the surface palette as a `const` in painterly.ts, which meant
// every palette change was a code change — and palette is precisely the thing
// this project iterates on. These defs are the source of truth now; the TS side
// only holds the defaults a def may omit.
//
// The shape is deliberately the one ARCHITECTURE describes for the Forge:
// `{ id, version, type, material, ... }`. When the Forge lands (M5) it reads and
// writes these same files, and the in-game inspector edits them live.

import type { PainterlyParams } from './painterly'
import { PAINTERLY_DEFAULTS } from './painterly'

/** Colours are authored as "#rrggbb" strings; everything else is a number. */
type MaterialDef = Record<string, string | number>

export interface AssetDef {
  id: string
  version: number
  type: string
  notes?: string
  material: MaterialDef
}

const COLOUR_KEYS = ['base', 'shadow', 'lit', 'top'] as const
type ColourKey = (typeof COLOUR_KEYS)[number]
const isColourKey = (k: string): k is ColourKey =>
  (COLOUR_KEYS as readonly string[]).includes(k)

const NUMERIC_KEYS = Object.keys(PAINTERLY_DEFAULTS)
  .filter((k) => !isColourKey(k))

function parseHex(id: string, key: string, v: string | number): number {
  if (typeof v === 'number') return v
  const m = /^#([0-9a-fA-F]{6})$/.exec(v)
  if (!m?.[1]) throw new Error(`${id}.material.${key}: expected "#rrggbb", got ${JSON.stringify(v)}`)
  return parseInt(m[1], 16)
}

/**
 * Validate a def and fold it onto the defaults.
 *
 * Strict on purpose: a typo'd key would otherwise be silently dropped and the
 * surface would render with the default palette, which is exactly the kind of
 * failure that costs a whole screenshot round to notice.
 */
export function surfaceParams(def: AssetDef): PainterlyParams {
  const out: PainterlyParams = { ...PAINTERLY_DEFAULTS }
  for (const [key, value] of Object.entries(def.material)) {
    if (isColourKey(key)) {
      out[key] = parseHex(def.id, key, value)
    } else if (NUMERIC_KEYS.includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${def.id}.material.${key}: expected a number, got ${JSON.stringify(value)}`)
      }
      // Indexing through a narrowed union keeps this assignment type-safe
      // without a cast per key.
      ;(out as unknown as Record<string, number>)[key] = value
    } else {
      throw new Error(`${def.id}.material.${key}: not a PainterlyParams key`)
    }
  }
  return out
}

// Bundled at build time, so there is no async load to race `__ready` against
// and the screenshot harness stays deterministic.
const modules = import.meta.glob<{ default: AssetDef }>(
  '/assets/defs/surfaces/*.json', { eager: true },
)

const REGISTRY = new Map<string, PainterlyParams>()
for (const mod of Object.values(modules)) {
  const def = mod.default
  if (def.type !== 'surface') continue
  if (REGISTRY.has(def.id)) throw new Error(`duplicate asset def id: ${def.id}`)
  REGISTRY.set(def.id, surfaceParams(def))
}

/** Every surface id present in assets/defs/surfaces. */
export function surfaceIds(): string[] {
  return [...REGISTRY.keys()].sort()
}

/** Look up a surface by def id. Throws rather than silently substituting. */
export function surface(id: string): PainterlyParams {
  const p = REGISTRY.get(id)
  if (!p) throw new Error(`no surface def "${id}" (have: ${surfaceIds().join(', ')})`)
  return p
}
