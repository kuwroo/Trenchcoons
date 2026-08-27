// Param schemas for asset generators.
//
// ARCHITECTURE, "Asset Forge": "A generator is a typed function `params ->
// geometry`. Its param schema is declared alongside it, which gives three
// things for free: the Forge UI auto-builds its sliders, the LLM knows exactly
// what it may change, and edits are validated before they render."
//
// All three of those depend on the schema being DATA, not a TypeScript type —
// a type is erased at runtime and can validate neither a JSON def nor an LLM
// patch. So the schema is a value, and the params type is derived FROM it, and
// there is exactly one place a param can be declared.

export interface NumberSpec {
  kind: 'number'
  default: number
  min: number
  max: number
  /** Forge slider granularity. Not enforced on load — clamping is. */
  step?: number
  doc: string
  /** Metres, degrees, ... purely for the Forge readout. */
  unit?: string
}
export interface IntSpec {
  kind: 'int'
  default: number
  min: number
  max: number
  doc: string
}
export interface BoolSpec {
  kind: 'bool'
  default: boolean
  doc: string
}
export interface EnumSpec<V extends string = string> {
  kind: 'enum'
  default: V
  values: readonly V[]
  doc: string
}

export type ParamSpec = NumberSpec | IntSpec | BoolSpec | EnumSpec
export type Schema = Readonly<Record<string, ParamSpec>>
export type ParamValue = number | boolean | string

type ValueOf<P extends ParamSpec> =
  P extends NumberSpec | IntSpec ? number
    : P extends BoolSpec ? boolean
      : P extends EnumSpec<infer V> ? V
        : never

/** The typed params object a generator receives. Derived, never hand-written. */
export type Params<S extends Schema> = { readonly [K in keyof S]: ValueOf<S[K]> }

/** Declaration helper that keeps enum literals narrow through inference. */
export const num = (
  def: number, min: number, max: number, doc: string, unit?: string, step?: number,
): NumberSpec => ({ kind: 'number', default: def, min, max, doc, ...(unit !== undefined ? { unit } : {}), ...(step !== undefined ? { step } : {}) })
export const int = (def: number, min: number, max: number, doc: string): IntSpec =>
  ({ kind: 'int', default: def, min, max, doc })
export const bool = (def: boolean, doc: string): BoolSpec => ({ kind: 'bool', default: def, doc })
export const oneOf = <const V extends string>(
  def: V, values: readonly V[], doc: string,
): EnumSpec<V> => ({ kind: 'enum', default: def, values, doc })

/**
 * Validate a raw param bag against a schema and fold it onto the defaults.
 *
 * Strict on unknown keys, exactly like `surfaceParams` in material/defs.ts and
 * for the same reason: a typo'd key would otherwise be silently dropped, the
 * asset would generate with the default value, and the failure would look like
 * a generator bug rather than a def bug. That mistake costs a whole screenshot
 * round to find.
 *
 * Out-of-range numbers are CLAMPED rather than rejected. The Forge's prompt box
 * hands this function LLM output, and a request for a 40 m boulder should give
 * the biggest boulder the schema allows, not a stack trace.
 */
export function applySchema<S extends Schema>(
  id: string, schema: S, raw: Readonly<Record<string, unknown>> = {},
): Params<S> {
  const out: Record<string, ParamValue> = {}
  for (const [key, spec] of Object.entries(schema)) out[key] = spec.default
  for (const [key, value] of Object.entries(raw)) {
    const spec = schema[key]
    if (!spec) {
      throw new Error(
        `${id}.params.${key}: not a param of this generator ` +
        `(have: ${Object.keys(schema).sort().join(', ')})`,
      )
    }
    out[key] = coerce(id, key, spec, value)
  }
  return out as Params<S>
}

function coerce(id: string, key: string, spec: ParamSpec, value: unknown): ParamValue {
  switch (spec.kind) {
    case 'number':
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${id}.params.${key}: expected a number, got ${JSON.stringify(value)}`)
      }
      const c = Math.min(spec.max, Math.max(spec.min, value))
      return spec.kind === 'int' ? Math.round(c) : c
    }
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`${id}.params.${key}: expected a boolean, got ${JSON.stringify(value)}`)
      }
      return value
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new Error(
          `${id}.params.${key}: expected one of ${spec.values.join(' | ')}, ` +
          `got ${JSON.stringify(value)}`,
        )
      }
      return value
  }
}
