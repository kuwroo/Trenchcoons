// What a generated asset IS, as far as the rest of the game is concerned.
//
// Three things, and the third is the one the world team is blocked on:
//
//   parts     one geometry per SURFACE, each with its own LOD ladder and an
//             impostor. One part = one InstancedMesh = one draw call per LOD in
//             use, so the part count is the draw-call budget.
//   collider  a convex hull or a set of primitives, in the asset's own local
//             space, so the world can put the kart into a rock and have it stop.
//   bounds    footprint radius and height, which is what scatter placement,
//             the chase camera's obstacle avoidance and the `Obstacle` list in
//             world/greybox.ts all actually want.

import type * as THREE from 'three/webgpu'
import type { PainterlyParams } from '../material/painterly'

/** One level of a part's LOD ladder. */
export interface AssetLod {
  geometry: THREE.BufferGeometry
  triangles: number
  /**
   * Camera distance in metres at which this level STOPS being used. The last
   * ladder entry hands over to the impostor.
   */
  until: number
}

export interface AssetPart {
  /** Slot name the generator declared, e.g. 'body', 'foliage', 'trunk'. */
  slot: string
  /** Painterly surface def id from assets/defs/surfaces. */
  surface: string
  /**
   * The surface's params, resolved: the named def, with its vertical gradient
   * re-scaled to this asset's real height, plus any per-def overrides.
   *
   * Resolved here rather than looked up at draw time because the gradient
   * rescale needs the asset's bounds, which only exist after generation. See
   * `resolveMaterial` in registry.ts for why the rescale is not optional.
   */
  material: PainterlyParams
  /** LOD0 first. Always at least one entry. */
  lods: AssetLod[]
  /**
   * Distance stand-in. Not a rendered-to-texture impostor: this build has no
   * texture pipeline for assets and the shared painterly material reads no UVs,
   * so a baked atlas would need a whole second material path. It is a pair of
   * crossed silhouette cards carrying the part's real outline with outward
   * splayed normals, which under aerial perspective — the thing actually
   * carrying distance in this art direction (ART_BIBLE §1) — is
   * indistinguishable from the mesh and costs 4-12 triangles.
   */
  impostor: AssetLod
  /**
   * True when the impostor IS the coarsest mesh rung rather than a separate
   * geometry. Convex solids end up here: a rock's last rung is already a
   * ten-face block, and a crossed card would be both dearer and worse — it
   * reads as a paper cutout the moment the sun is off-axis. Sharing costs one
   * fewer batch, so this is the cheap case, not a compromise.
   */
  impostorShared: boolean
}

export type ColliderShape =
  | { kind: 'hull'; points: Float32Array }
  | { kind: 'box'; half: [number, number, number]; at: [number, number, number]; yaw: number }
  | { kind: 'sphere'; radius: number; at: [number, number, number] }
  | {
    kind: 'capsule'
    radius: number
    /** Half the length of the cylindrical section, along local +Y. */
    halfHeight: number
    at: [number, number, number]
  }
  | {
    kind: 'cylinder'
    radius: number
    halfHeight: number
    at: [number, number, number]
  }

export interface Collider {
  /** All in the asset's local space, pre-instance-transform. */
  shapes: ColliderShape[]
  /**
   * Whether the kart should collide with this at all. Grass is a collider of
   * zero shapes on purpose: it exists so the world can ask every asset the same
   * question rather than special-casing vegetation.
   */
  solid: boolean
}

export interface AssetBounds {
  /** Horizontal radius of the footprint, metres. Feeds `Obstacle.r`. */
  footprint: number
  /** Local-space Y extent, metres. */
  height: number
  /** Bounding sphere radius about the local origin. */
  radius: number
}

export interface GeneratedAsset {
  id: string
  generator: string
  /** Which of the def's variants this is. 0-based. */
  variant: number
  parts: AssetPart[]
  collider: Collider
  bounds: AssetBounds
  /** LOD0 triangles summed over every part. The number a budget cares about. */
  triangles: number
}

/**
 * A generator declares its slots so a def can be validated before it renders:
 * a def that names a surface for a slot the generator does not have, or misses
 * one it does, fails at load rather than producing an untextured mesh.
 */
export interface GeneratorInfo {
  name: string
  slots: readonly string[]
  /** Fallback surface per slot, used when a def does not override it. */
  defaultSurfaces: Readonly<Record<string, string>>
}
