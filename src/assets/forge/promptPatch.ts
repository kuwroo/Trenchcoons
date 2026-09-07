// Natural-language → reviewable patch for the Environments editor.
//
// ARCHITECTURE: "Prompt box — natural language → LLM returns a *param patch*
// → shown as a diff → accept or reject. It edits parameters, never geometry
// directly." This module is the deterministic local interpreter used until a
// remote LLM is wired; every change still lands as a typed patch the user
// accepts, so the review step stays intact.

import type { AssetRules, ScatterDef } from '../registry'
import { generators, scatterDef } from '../registry'
import type { BiomeId, BiomeStyle, ScatterEntry } from '../../terrain/biomes'
import { BIOME_IDS } from '../../terrain/biomes'
import type { Schema } from '../schema'

export interface PromptContext {
  biome: BiomeId
  style: BiomeStyle
  /** Asset currently selected in the outliner, if any. */
  assetId: string | null
  /** In-memory rules draft for that asset (may differ from the JSON def). */
  rules: AssetRules | null
}

export interface PromptPatch {
  summary: string
  warnings: string[]
  /** Replace the whole biome scatter list when set. */
  scatter?: ScatterEntry[]
  /** Merge into the selected asset's rules draft. */
  rules?: AssetRules
  /** Param overrides for the selected asset's def (export-only until regen). */
  params?: Record<string, number>
  /** Soft biome style numeric tweaks. */
  styleNums?: Partial<Pick<BiomeStyle, 'grassDensity' | 'grassScale' | 'fogDensity' | 'ambient' | 'relief'>>
}

const BIOME_WORDS: Record<string, BiomeId> = {
  meadow: 'meadow', grassland: 'meadow', grass: 'meadow',
  forest: 'forest', woods: 'forest', woodland: 'forest',
  desert: 'desert', sand: 'desert', dune: 'desert',
  alpine: 'alpine', snow: 'alpine', mountain: 'alpine',
  wetland: 'wetland', swamp: 'wetland', marsh: 'wetland', mud: 'wetland',
  coast: 'coast', beach: 'coast', shore: 'coast',
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function parseNumber(s: string): number | null {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function degToRad(d: number): number {
  return d * Math.PI / 180
}

function schemaOf(def: ScatterDef): Schema | null {
  const gen = generators().find((g) => g.info.name === def.generator)
  return gen?.schema ?? null
}

/** Scale every scatter density in the biome by `factor`. */
function scaleDensities(style: BiomeStyle, factor: number): ScatterEntry[] {
  return style.scatter.map((e) => ({
    ...e,
    perKm2: Math.round(clamp(e.perKm2 * factor, 0, 40_000)),
    scale: [e.scale[0], e.scale[1]] as [number, number],
  }))
}

function scaleOne(
  style: BiomeStyle, id: string, factor: number,
): ScatterEntry[] | null {
  if (!style.scatter.some((e) => e.id === id)) return null
  return style.scatter.map((e) => e.id !== id ? { ...e, scale: [...e.scale] as [number, number] } : {
    ...e,
    perKm2: Math.round(clamp(e.perKm2 * factor, 0, 40_000)),
    scale: [e.scale[0], e.scale[1]] as [number, number],
  })
}

/**
 * Turn a prompt into a patch. Returns null when nothing actionable was found,
 * with warnings explaining what was understood.
 */
export function interpretPrompt(text: string, ctx: PromptContext): PromptPatch | null {
  const raw = text.trim()
  if (!raw) return null
  const q = raw.toLowerCase()
  const warnings: string[] = []
  const patch: PromptPatch = { summary: '', warnings }

  // ── density ──────────────────────────────────────────────────────────────
  if (/\b(denser|more dense|thicker|more trees|more rocks|fill(?:ed)? in)\b/.test(q)) {
    const factor = /\b(much|way|lot)\b/.test(q) ? 1.6 : 1.25
    const id = ctx.assetId
    const scatter = id ? scaleOne(ctx.style, id, factor) : scaleDensities(ctx.style, factor)
    if (scatter) {
      patch.scatter = scatter
      patch.summary = id
        ? `Raise ${id} density ×${factor.toFixed(2)} in ${ctx.biome}`
        : `Raise all ${ctx.biome} scatter density ×${factor.toFixed(2)}`
    }
  } else if (/\b(sparser|thinner|fewer|less dense|clear(?:er)?)\b/.test(q)) {
    const factor = /\b(much|way|lot)\b/.test(q) ? 0.55 : 0.75
    const id = ctx.assetId
    const scatter = id ? scaleOne(ctx.style, id, factor) : scaleDensities(ctx.style, factor)
    if (scatter) {
      patch.scatter = scatter
      patch.summary = id
        ? `Lower ${id} density ×${factor.toFixed(2)} in ${ctx.biome}`
        : `Lower all ${ctx.biome} scatter density ×${factor.toFixed(2)}`
    }
  }

  // ── explicit density number ──────────────────────────────────────────────
  const dens = q.match(/\b(?:density|per\s*km2|perkm2)\s*[:=]?\s*(\d+(?:\.\d+)?)\b/)
  if (dens && ctx.assetId) {
    const v = parseNumber(dens[1]!)
    if (v !== null) {
      const scatter = ctx.style.scatter.map((e) => {
        if (e.id !== ctx.assetId) return { ...e, scale: [...e.scale] as [number, number] }
        return { ...e, perKm2: Math.round(clamp(v, 0, 40_000)), scale: [...e.scale] as [number, number] }
      })
      if (!ctx.style.scatter.some((e) => e.id === ctx.assetId)) {
        scatter.push({
          id: ctx.assetId,
          perKm2: Math.round(clamp(v, 0, 40_000)),
          scale: [0.8, 1.2],
          maxSlope: ctx.rules?.maxSlope ?? 0.6,
        })
      }
      patch.scatter = scatter
      patch.summary = (patch.summary ? patch.summary + '; ' : '') +
        `Set ${ctx.assetId} density to ${Math.round(v)}/km² in ${ctx.biome}`
    }
  }

  // ── scale ────────────────────────────────────────────────────────────────
  if (ctx.assetId && /\b(bigger|larger|taller|huge)\b/.test(q)) {
    const factor = /\b(much|way|lot)\b/.test(q) ? 1.35 : 1.15
    patch.scatter = ctx.style.scatter.map((e) => {
      if (e.id !== ctx.assetId) return { ...e, scale: [...e.scale] as [number, number] }
      return {
        ...e,
        scale: [
          clamp(e.scale[0] * factor, 0.2, 3),
          clamp(e.scale[1] * factor, 0.2, 3),
        ] as [number, number],
      }
    })
    patch.summary = (patch.summary ? patch.summary + '; ' : '') +
      `Scale up ${ctx.assetId} ×${factor.toFixed(2)}`
    // Also nudge authored height/size params when the schema has them.
    try {
      const def = scatterDef(ctx.assetId)
      const schema = schemaOf(def)
      const params: Record<string, number> = {}
      if (schema?.height?.kind === 'number' || schema?.height?.kind === 'int') {
        const cur = Number(def.params?.height ?? schema.height.default)
        params.height = clamp(cur * factor, schema.height.min, schema.height.max)
      }
      if (schema?.size?.kind === 'number' || schema?.size?.kind === 'int') {
        const cur = Number(def.params?.size ?? schema.size.default)
        params.size = clamp(cur * factor, schema.size.min, schema.size.max)
      }
      if (Object.keys(params).length) patch.params = params
    } catch { /* unknown id */ }
  } else if (ctx.assetId && /\b(smaller|shorter|tiny)\b/.test(q)) {
    const factor = /\b(much|way|lot)\b/.test(q) ? 0.7 : 0.85
    patch.scatter = ctx.style.scatter.map((e) => {
      if (e.id !== ctx.assetId) return { ...e, scale: [...e.scale] as [number, number] }
      return {
        ...e,
        scale: [
          clamp(e.scale[0] * factor, 0.2, 3),
          clamp(e.scale[1] * factor, 0.2, 3),
        ] as [number, number],
      }
    })
    patch.summary = (patch.summary ? patch.summary + '; ' : '') +
      `Scale down ${ctx.assetId} ×${factor.toFixed(2)}`
  }

  // ── max slope ────────────────────────────────────────────────────────────
  const slopeDeg = q.match(/\bmax\s*slope\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(deg|°)?/)
  const slopeRad = q.match(/\bmax\s*slope\s*[:=]?\s*(0?\.\d+)\s*rad/)
  if (ctx.assetId && (slopeDeg || slopeRad)) {
    const rad = slopeRad
      ? parseNumber(slopeRad[1]!)
      : degToRad(parseNumber(slopeDeg![1]!) ?? 30)
    if (rad !== null) {
      const maxSlope = clamp(rad, 0.05, 1.4)
      patch.scatter = (patch.scatter ?? ctx.style.scatter).map((e) => {
        if (e.id !== ctx.assetId) return { ...e, scale: [...e.scale] as [number, number] }
        return { ...e, maxSlope, scale: [...e.scale] as [number, number] }
      })
      patch.rules = { ...(patch.rules ?? ctx.rules ?? {}), maxSlope }
      patch.summary = (patch.summary ? patch.summary + '; ' : '') +
        `Max slope ${(maxSlope * 180 / Math.PI).toFixed(0)}° for ${ctx.assetId}`
    }
  }

  // ── biome membership ─────────────────────────────────────────────────────
  const only = q.match(/\bonly\s+(?:in\s+)?([a-z]+)/)
  const addBiome = q.match(/\b(?:add(?:ed)?|allow|use)\s+(?:in\s+)?([a-z]+)/)
  const removeBiome = q.match(/\b(?:remove|drop|ban)\s+(?:from\s+)?([a-z]+)/)
  if (ctx.assetId && only) {
    const b = BIOME_WORDS[only[1]!]
    if (b) {
      patch.rules = { ...(patch.rules ?? ctx.rules ?? {}), biomes: [b] }
      patch.summary = (patch.summary ? patch.summary + '; ' : '') +
        `Restrict ${ctx.assetId} to ${b}`
    } else {
      warnings.push(`unknown biome "${only[1]}"`)
    }
  } else if (ctx.assetId && addBiome) {
    const b = BIOME_WORDS[addBiome[1]!]
    if (b) {
      const cur = [...(ctx.rules?.biomes ?? scatterDef(ctx.assetId).biomes ?? [])]
      if (!cur.includes(b)) cur.push(b)
      patch.rules = { ...(patch.rules ?? ctx.rules ?? {}), biomes: cur }
      patch.summary = (patch.summary ? patch.summary + '; ' : '') +
        `Allow ${ctx.assetId} in ${b}`
    }
  } else if (ctx.assetId && removeBiome) {
    const b = BIOME_WORDS[removeBiome[1]!]
    if (b) {
      const cur = (ctx.rules?.biomes ?? scatterDef(ctx.assetId).biomes ?? []).filter((x) => x !== b)
      patch.rules = { ...(patch.rules ?? ctx.rules ?? {}), biomes: cur }
      patch.summary = (patch.summary ? patch.summary + '; ' : '') +
        `Disallow ${ctx.assetId} in ${b}`
    }
  }

  // ── placement text ───────────────────────────────────────────────────────
  const place = raw.match(/\bplacement\s*:\s*(.+)$/i) ?? raw.match(/\brule\s*:\s*(.+)$/i)
  if (ctx.assetId && place) {
    patch.rules = { ...(patch.rules ?? ctx.rules ?? {}), placement: place[1]!.trim() }
    patch.summary = (patch.summary ? patch.summary + '; ' : '') +
      `Update placement rule for ${ctx.assetId}`
  }

  // ── grass / fog / ambient on the biome ───────────────────────────────────
  if (/\bmore grass\b/.test(q)) {
    patch.styleNums = {
      ...(patch.styleNums ?? {}),
      grassDensity: clamp(ctx.style.grassDensity * 1.25, 0, 2.5),
    }
    patch.summary = (patch.summary ? patch.summary + '; ' : '') + 'More grass'
  } else if (/\bless grass\b|\bno grass\b/.test(q)) {
    patch.styleNums = {
      ...(patch.styleNums ?? {}),
      grassDensity: /\bno grass\b/.test(q) ? 0 : clamp(ctx.style.grassDensity * 0.7, 0, 2.5),
    }
    patch.summary = (patch.summary ? patch.summary + '; ' : '') +
      (/\bno grass\b/.test(q) ? 'Clear grass' : 'Less grass')
  }
  if (/\bthicker fog\b|\bmore fog\b|\bhazier\b/.test(q)) {
    patch.styleNums = {
      ...(patch.styleNums ?? {}),
      fogDensity: clamp(ctx.style.fogDensity * 1.2, 0.2, 2.5),
    }
    patch.summary = (patch.summary ? patch.summary + '; ' : '') + 'Thicker fog'
  } else if (/\bthinner fog\b|\bless fog\b|\bclearer air\b/.test(q)) {
    patch.styleNums = {
      ...(patch.styleNums ?? {}),
      fogDensity: clamp(ctx.style.fogDensity * 0.8, 0.2, 2.5),
    }
    patch.summary = (patch.summary ? patch.summary + '; ' : '') + 'Thinner fog'
  }

  // ── add asset to biome scatter set ───────────────────────────────────────
  const addAsset = q.match(/\badd\s+([a-z0-9-]+)\b/)
  if (addAsset) {
    const id = addAsset[1]!
    try {
      const def = scatterDef(id)
      if (!ctx.style.scatter.some((e) => e.id === id)) {
        const lo = def.rules?.densityPerKm2?.[0] ?? 200
        const hi = def.rules?.densityPerKm2?.[1] ?? 400
        const dens = Math.round((lo + hi) / 2)
        const scale = (def.rules?.scale ?? [0.8, 1.2]) as [number, number]
        patch.scatter = [
          ...ctx.style.scatter.map((e) => ({ ...e, scale: [...e.scale] as [number, number] })),
          {
            id,
            perKm2: dens,
            scale: [scale[0], scale[1]],
            maxSlope: def.rules?.maxSlope ?? 0.6,
          },
        ]
        patch.summary = (patch.summary ? patch.summary + '; ' : '') +
          `Add ${id} to ${ctx.biome} (~${dens}/km²)`
      } else {
        warnings.push(`${id} is already in ${ctx.biome}`)
      }
    } catch {
      // "add forest" biome word — ignore if not an asset id
      if (!BIOME_IDS.includes(id as BiomeId) && !BIOME_WORDS[id]) {
        warnings.push(`unknown asset "${id}"`)
      }
    }
  }

  if (!patch.summary && !patch.scatter && !patch.rules && !patch.params && !patch.styleNums) {
    warnings.push(
      'Nothing matched. Try: "denser", "sparser", "bigger", "max slope 25 deg", ' +
      '"only in alpine", "placement: sits on ridge breaks", "add rock-slab", "more grass".',
    )
    return { summary: '', warnings }
  }
  return patch
}

/** Pretty-print a patch for the review pane. */
export function formatPatchDiff(patch: PromptPatch): string {
  const lines: string[] = []
  if (patch.summary) lines.push(`# ${patch.summary}`)
  if (patch.scatter) {
    lines.push('scatter:')
    for (const e of patch.scatter) {
      lines.push(
        `  - ${e.id}  ${e.perKm2}/km²  scale ${e.scale[0].toFixed(2)}..${e.scale[1].toFixed(2)}` +
        (e.maxSlope !== undefined ? `  slope≤${e.maxSlope.toFixed(2)}` : ''),
      )
    }
  }
  if (patch.rules) {
    lines.push('rules: ' + JSON.stringify(patch.rules, null, 2))
  }
  if (patch.params) {
    lines.push('params: ' + JSON.stringify(patch.params, null, 2))
  }
  if (patch.styleNums) {
    lines.push('style: ' + JSON.stringify(patch.styleNums, null, 2))
  }
  for (const w of patch.warnings) lines.push(`! ${w}`)
  return lines.join('\n')
}
