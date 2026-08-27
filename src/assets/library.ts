// The scatter library as the world consumes it.
//
// The world team owns placement — where a rock goes, how dense the grass is,
// which biome gets which set. This owns everything else: geometry, LOD ladders,
// impostors, materials and collision proxies, keyed so that placement is a
// matter of pushing matrices at a batch.
//
// One material per SURFACE, not per asset. Batching is by (geometry, material)
// and the geometry already differs per asset, so sharing the material across
// every asset that uses `rock` costs nothing and saves the uniform uploads and
// the pipeline compiles.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { PainterlyMaterial, type PainterlyParams } from '../material/painterly'
import { graded } from '../world/surfaceGrade'
import { allScatterAssets, scatterAsset, scatterIds, scatterVariants } from './registry'
import type { AssetLod, AssetPart, Collider, GeneratedAsset } from './types'

/** One instanceable unit: a geometry, a material and where it sits in the ladder. */
export interface ScatterBatch {
  key: string
  assetId: string
  variant: number
  slot: string
  surface: string
  /** 0-based rung, or -1 for the impostor. */
  lod: number
  geometry: THREE.BufferGeometry
  material: THREE.Material
  triangles: number
  /** Camera distance below which this rung is the right one. */
  until: number
}

export class ScatterLibrary {
  readonly materials: PainterlyMaterial[] = []
  private readonly bySurface = new Map<string, PainterlyMaterial>()

  constructor(private readonly atmosphere: Atmosphere) {}

  /**
   * The material for a resolved param set, cached by value.
   *
   * Keyed by the params themselves rather than by surface id, because two
   * assets on the same surface can legitimately want different `ambient` or a
   * different gradient sweep — see `resolveMaterial` in registry.ts. Assets
   * that resolve to identical params share one material and one pipeline.
   */
  material(surfaceId: string, params: PainterlyParams): THREE.Material {
    // GRADED HERE, not at the call site, because the Forge and the game used to
    // grade differently and the Forge is the surface that asset work is judged
    // on. `src/world/scatter.ts` called `graded()` and this did not, so every
    // asset in the Forge rendered under the RAW def while the same asset in the
    // world rendered under the GRADE override — for `stone` that is ambient
    // 4.9 against 1.75 and a ramp of [-0.05, 0.88] against [0.26, 0.74], i.e.
    // the Forge showed one flat band lit almost entirely by the blue sky LUT.
    // A modeller tuning rock FORM against that preview is reading a material
    // bug as a geometry bug. One grade, one point of use, both paths agree.
    const clean = graded(surfaceId, params)
    const key = `${surfaceId}|${JSON.stringify(clean)}`
    const hit = this.bySurface.get(key)
    if (hit) return hit.material
    const m = new PainterlyMaterial(this.atmosphere, clean)
    this.bySurface.set(key, m)
    this.materials.push(m)
    return m.material
  }

  asset(id: string, variant = 0): GeneratedAsset {
    return scatterAsset(id, variant)
  }

  ids(): string[] { return scatterIds() }
  variants(id: string): number { return scatterVariants(id) }
  collider(id: string, variant = 0): Collider { return scatterAsset(id, variant).collider }

  /** Every rung of every part of every variant of every def. */
  batches(): ScatterBatch[] {
    const out: ScatterBatch[] = []
    for (const asset of allScatterAssets()) {
      for (const part of asset.parts) {
        for (const b of this.partBatches(asset, part)) out.push(b)
      }
    }
    return out
  }

  /** The batches for one asset variant, which is what a scatter pass wants. */
  batchesFor(id: string, variant = 0): ScatterBatch[] {
    const asset = scatterAsset(id, variant)
    const out: ScatterBatch[] = []
    for (const part of asset.parts) out.push(...this.partBatches(asset, part))
    return out
  }

  /**
   * A shared impostor emits no batch of its own: its geometry IS the last
   * rung's, so the rung simply keeps being drawn out to infinity.
   */
  private partBatches(asset: GeneratedAsset, part: AssetPart): ScatterBatch[] {
    const out: ScatterBatch[] = part.lods.map((l, i) => this.batch(
      asset, part, i,
      part.impostorShared && i === part.lods.length - 1 ? { ...l, until: Infinity } : l,
    ))
    if (!part.impostorShared) out.push(this.batch(asset, part, -1, part.impostor))
    return out
  }

  private batch(
    asset: GeneratedAsset, part: AssetPart, lod: number, entry: AssetLod,
  ): ScatterBatch {
    return {
      key: `${asset.id}#${asset.variant}/${part.slot}/${lod < 0 ? 'imp' : `lod${lod}`}`,
      assetId: asset.id,
      variant: asset.variant,
      slot: part.slot,
      surface: part.surface,
      lod,
      geometry: entry.geometry,
      material: this.material(part.surface, part.material),
      triangles: entry.triangles,
      until: entry.until,
    }
  }
}
