// Asset Forge — the scatter library's public surface.
//
// Assets are PARAMETRIC: a typed `params -> geometry` generator plus a JSON def
// in assets/defs/scatter, per ARCHITECTURE's "Asset Forge". Nothing here is a
// baked mesh and nothing bypasses the registry.
//
// For the world team, the three things you need are:
//
//   new ScatterLibrary(atmosphere).batchesFor('rock-medium')   geometry + material
//   scatterAsset('rock-medium').collider                       collision proxy
//   scatterAsset('rock-medium').bounds.footprint               Obstacle.r
//
// Every asset has three mesh LOD rungs plus an impostor, and every asset has a
// collider — vegetation's is `{ shapes: [], solid: false }`, which is an answer
// rather than an omission.

export { ScatterLibrary, type ScatterBatch } from './library'
export {
  allScatterAssets, generators, pickLod, scatterAsset, scatterDef, scatterIds,
  scatterVariants, type AssetRules, type ScatterDef,
} from './registry'
export { scatterBudget, variantCounts, BATCH_CEILING, TRIANGLE_CEILING } from './budget'
export { colliderGeometry } from './collider'
export type {
  AssetBounds, AssetLod, AssetPart, Collider, ColliderShape, GeneratedAsset, GeneratorInfo,
} from './types'
export type { ParamSpec, Schema } from './schema'
