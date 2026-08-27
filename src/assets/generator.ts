// The generator contract.
//
// A generator is `params -> geometry`, per ARCHITECTURE's Asset Forge section.
// It returns RAW parts — geometry ladders and a collider — and knows nothing
// about surfaces, LOD distances or JSON. The registry binds those, because they
// come from the def and a generator that read its own def could not be driven
// from a Forge slider.

import type * as THREE from 'three/webgpu'
import type { Rng } from '../core/rng'
import { applySchema, type Params, type Schema } from './schema'
import type { AssetBounds, Collider, GeneratorInfo } from './types'

export interface GenContext {
  /** Def id plus variant index, for error messages and derived seeds. */
  id: string
  variant: number
  /** Already forked per (def, variant). Generators may use it freely. */
  rng: Rng
}

export interface RawPart {
  slot: string
  /** LOD0 first. At least one. */
  lods: THREE.BufferGeometry[]
  impostor: THREE.BufferGeometry
}

export interface RawAsset {
  parts: RawPart[]
  collider: Collider
  bounds: AssetBounds
}

export interface Generator<S extends Schema> {
  info: GeneratorInfo
  schema: S
  generate(params: Params<S>, ctx: GenContext): RawAsset
}

/** Schema-erased view, which is what the registry can actually hold. */
export interface AnyGenerator {
  info: GeneratorInfo
  schema: Schema
  generate(raw: Readonly<Record<string, unknown>>, ctx: GenContext): RawAsset
}

/**
 * Bind a typed generator into the registry's erased form, validating params on
 * the way in. The cast happens exactly once, here, so every generator body
 * stays fully typed against its own schema.
 */
export function defineGenerator<S extends Schema>(g: Generator<S>): AnyGenerator {
  return {
    info: g.info,
    schema: g.schema,
    generate: (raw, ctx) => g.generate(applySchema(ctx.id, g.schema, raw), ctx),
  }
}

/** Seeded direction on the unit sphere, optionally squashed toward horizontal. */
export function randomDirection(rng: Rng, yBias: number): [number, number, number] {
  // yBias 0 -> uniform on the sphere. yBias 1 -> everything in the XZ plane,
  // i.e. a vertical fracture face. -1 -> everything near the poles, i.e. a
  // bedding plane.
  const a = rng.range(0, Math.PI * 2)
  let y = rng.range(-1, 1)
  y = yBias >= 0 ? y * (1 - yBias) : Math.sign(y) * (Math.abs(y) * (1 + yBias) + (-yBias))
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  return [Math.cos(a) * r, y, Math.sin(a) * r]
}
