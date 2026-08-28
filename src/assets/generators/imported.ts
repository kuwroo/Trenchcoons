// Imported meshes: the low-poly nature pack, routed through the same door as
// everything else.
//
// CLAUDE.md's rule is that every asset is a JSON def driven by a generator,
// "including imported and AI-generated meshes", and this is what makes that
// true for a downloaded FBX. `tools/fbx-import.mjs` bakes the geometry to
// assets/meshes/*.json offline — the registry is synchronous and deterministic
// and a runtime loader would break both — and this generator turns one of those
// documents into an asset with a real LOD ladder and a collider, so an imported
// tree is indistinguishable from a generated one everywhere downstream.
//
// The pack ships one mesh, one white material and no texture, colouring by
// pointing UVs at a palette atlas that is not in the download. The importer
// recovers the artist's material split by clustering triangles on those UV
// patches and hands us `trunk` and `foliage` parts, which pick up the project's
// own painterly surfaces. See the note at the top of the importer.
import type * as THREE from 'three/webgpu'
import { MeshBuilder, type Vec3 } from '../mesh'
import { coarseSolid, coarseUnder } from '../impostor'
import { boundsFromPoints, cylinderShape, noCollision, solidCollider } from '../collider'
import { defineGenerator, type RawAsset } from '../generator'
import { num, str } from '../schema'

interface MeshPart { slot: string; positions: number[]; normals: number[]; indices: number[] }
interface MeshDoc { id: string; source: string; height: number; footprint: number; parts: MeshPart[] }

const modules = import.meta.glob<{ default: MeshDoc }>('/assets/meshes/*.json', { eager: true })
const MESHES = new Map<string, MeshDoc>()
for (const mod of Object.values(modules)) MESHES.set(mod.default.id, mod.default)

const schema = {
  mesh: str('', 'Id of a document in assets/meshes, produced by tools/fbx-import.mjs.'),
  scale: num(1, 0.02, 12, 'Uniform scale on the authored mesh.'),
  solidAbove: num(1.2, 0, 40, 'Scaled height above which the kart collides with it.', 'm'),
  radius: num(0.34, 0.05, 1, 'Collision radius as a fraction of the footprint.'),
} as const

/**
 * Vertex-cluster decimation: weld to a grid, drop the triangles that collapse.
 *
 * Crude, and right for this input. These are low-poly models whose silhouette is
 * carried by a few big planes, so snapping vertices to a grid a fraction of the
 * model's size removes the small stuff and leaves the read intact — where a
 * proper edge-collapse would cost far more code for a form this simple. The grid
 * is relative to the asset's own height so one number serves a 9 m birch and a
 * 0.3 m mushroom.
 */
function decimate(
  P: readonly number[], N: readonly number[], I: readonly number[], cell: number,
): { positions: number[]; normals: number[]; indices: number[] } {
  const map = new Map<string, number>()
  const remap = new Int32Array(P.length / 3)
  const positions: number[] = []
  const normals: number[] = []
  for (let v = 0; v < P.length / 3; v++) {
    const x = Math.round(P[v * 3]! / cell)
    const y = Math.round(P[v * 3 + 1]! / cell)
    const z = Math.round(P[v * 3 + 2]! / cell)
    const key = `${x},${y},${z}`
    let i = map.get(key)
    if (i === undefined) {
      i = positions.length / 3
      map.set(key, i)
      positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!)
      normals.push(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!)
    }
    remap[v] = i
  }
  const indices: number[] = []
  for (let t = 0; t < I.length; t += 3) {
    const a = remap[I[t]!]!
    const b = remap[I[t + 1]!]!
    const c = remap[I[t + 2]!]!
    if (a === b || b === c || a === c) continue
    indices.push(a, b, c)
  }
  return { positions, normals, indices }
}

/**
 * FLAT FACE NORMALS, discarding the authored smoothing.
 *
 * The pack's vertex normals are partly smoothed, and the project's whole form
 * language is flat sculptural planes meeting at hard edges — ART_BIBLE 1. A
 * smoothed low-poly canopy under this material reads as a soft blob; the same
 * geometry faceted reads as leaves. `MeshBuilder.tri` computes the face normal
 * when none is supplied, so this is also the cheaper path.
 */
function build(
  b: MeshBuilder, P: readonly number[], I: readonly number[], s: number,
): void {
  for (let t = 0; t < I.length; t += 3) {
    const v: Vec3[] = []
    for (const k of [I[t]!, I[t + 1]!, I[t + 2]!]) {
      v.push([P[k * 3]! * s, P[k * 3 + 1]! * s, P[k * 3 + 2]! * s])
    }
    b.tri(v[0]!, v[1]!, v[2]!)
  }
}

export const imported = defineGenerator({
  info: {
    name: 'imported',
    slots: ['body', 'trunk', 'foliage'],
    defaultSurfaces: { body: 'stone', trunk: 'bark', foliage: 'foliage' },
  },
  schema,
  generate(p, ctx): RawAsset {
    const doc = MESHES.get(p.mesh)
    if (!doc) {
      throw new Error(
        `${ctx.id}: no mesh "${p.mesh}" in assets/meshes ` +
        `(have: ${[...MESHES.keys()].join(', ')}). Run: node tools/fbx-import.mjs`,
      )
    }
    const s = p.scale
    const height = doc.height * s
    const all: Vec3[] = []
    const parts = doc.parts.map((part) => {
      // Two decimation steps sized off the asset, then a hull for the far rung.
      const lod0 = new MeshBuilder()
      build(lod0, part.positions, part.indices, s)
      const d1 = decimate(part.positions, part.normals, part.indices, doc.height * 0.055)
      const lod1 = new MeshBuilder()
      build(lod1, d1.positions, d1.indices, s)
      const d2 = decimate(part.positions, part.normals, part.indices, doc.height * 0.14)
      const lod2 = new MeshBuilder()
      build(lod2, d2.positions, d2.indices, s)
      for (let v = 0; v < part.positions.length; v += 3) {
        all.push([part.positions[v]! * s, part.positions[v + 1]! * s, part.positions[v + 2]! * s])
      }
      const g0 = lod0.build()
      const g1 = lod1.build()
      const g2 = lod2.build()
      const tri = (g: THREE.BufferGeometry): number => (g.index?.count ?? 0) / 3
      // Keep the ladder monotone: a decimation that did not actually get
      // cheaper is worse than useless, it costs a batch to draw the same thing.
      const rungs = [g0]
      if (tri(g1) < tri(g0)) rungs.push(g1)
      if (tri(g2) < tri(rungs[rungs.length - 1]!)) rungs.push(g2)
      const coarsest = rungs[rungs.length - 1]!
      const card = coarseSolid(all, 6)
      const impostor = (card.index?.count ?? 0) / 3 < tri(coarsest) ? card : coarsest
      if (impostor !== card) card.dispose()
      return { slot: part.slot, lods: rungs, impostor }
    })
    const bounds = boundsFromPoints(all)
    return {
      parts,
      // A cylinder, not the mesh hull: a canopy hull would stop the kart several
      // metres from a trunk it could otherwise drive under.
      collider: height >= p.solidAbove
        ? solidCollider(cylinderShape(
          bounds.footprint * p.radius, height * 0.5, [0, height * 0.5, 0],
        ))
        : noCollision(),
      bounds,
    }
  },
})
