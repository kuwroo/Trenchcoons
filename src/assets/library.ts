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
import { PainterlyMaterial } from '../material/painterly'
import { surface } from '../material/defs'
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
   * The material for a surface, with its vertical gradient re-scaled to the
   * asset's own height.
   *
   * This override is not optional and it is easy to miss. `gradientBase` and
   * `gradientHeight` in a surface def are OBJECT space, and every existing def
   * says so in its notes — they were authored against the greybox, where the
   * geometry is unit-sized and the instance matrix carries the scale. This
   * library authors in METRES, because a collision proxy and an LOD switch
   * distance are both meaningless without real units. Reusing `gradientHeight:
   * 1` on a 12 m conifer would saturate the sweep inside the first metre of
   * trunk and switch off the vertical gradient for the whole tree — which
   * ART_BIBLE §3 calls out as doing "enormous work in the Genshin and Capy
   * references".
   *
   * Bucketed to powers of two so a library of forty assets cannot turn into
   * forty materials and forty pipeline compiles. Within a bucket the gradient
   * is at most a factor of two off, which is invisible.
   */
  material(surfaceId: string, height = 1): THREE.Material {
    const bucket = Math.min(32, Math.max(0.5, Math.pow(2, Math.ceil(Math.log2(Math.max(0.25, height))))))
    const key = `${surfaceId}@${bucket}`
    const hit = this.bySurface.get(key)
    if (hit) return hit.material
    const m = new PainterlyMaterial(this.atmosphere, {
      ...surface(surfaceId),
      // Assets are authored with their base at y = 0, so the sweep starts there
      // and runs over the form's own height.
      gradientBase: 0,
      gradientHeight: bucket,
    })
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
      material: this.material(part.surface, asset.bounds.height),
      triangles: entry.triangles,
      until: entry.until,
    }
  }
}
