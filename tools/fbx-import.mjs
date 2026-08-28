// FBX -> compact mesh JSON, run offline.
//
//   node tools/fbx-import.mjs
//
// WHY OFFLINE. `scatterAsset(id, variant)` is synchronous and deterministic —
// the whole registry, the budget report and the screenshot harness depend on
// that — so a runtime FBXLoader is not an option. This bakes the geometry into
// assets/meshes/*.json, which an `imported` generator then reads like any other
// def. CLAUDE.md's rule holds: every asset is still a JSON def driven by a
// generator, "including imported and AI-generated meshes".
//
// WHY THE UV SPLIT. The pack ships one mesh, one white material and no texture:
// it colours by pointing UVs at a palette atlas that is not in the download. So
// the geometry arrives with no colour information at all, and a naive import
// makes a tree one flat hue — trunk the same as leaves. But the UVs are not
// scattered, they sit in a handful of tight patches, one per palette swatch:
//
//   PP_Tree_02        4 uv cells   95% at (0.948,0.831),  4% at (0.662,0.473)
//   PP_Birch_Tree_05  9 uv cells   57% around (0.81,0.81), 29% around (0.56,0.60)
//
// Clustering triangles by UV patch therefore recovers exactly the material
// split the artist authored, and the patch that reaches LOWEST in y is the
// trunk (Tree_02 -404 against the canopy's -235; Birch -486 against -130).
// Those groups become our `trunk` and `foliage` slots and pick up the project's
// own painterly surfaces, so imported trees light like everything else.
import * as THREE from 'three'
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture() }
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env['PP_DIR']
  ?? '/Users/chloeongsiyi/Downloads/PP_FreeLowPolyNaturePack_v3.0_Fbx_files_unique'
const OUT = 'assets/meshes'

/** source file -> { id, slots }. `slots: 1` means the whole mesh is one part. */
const WANTED = [
  { src: 'PP_Tree_02', id: 'pp-tree-broad', split: true },
  { src: 'PP_Tree_10', id: 'pp-tree-round', split: true },
  { src: 'PP_Birch_Tree_05', id: 'pp-birch-tall', split: true },
  { src: 'PP_Birch_Tree_06', id: 'pp-birch-young', split: true },
  { src: 'PP_Rock_Moss_Grown_09', id: 'pp-rock-mossy', split: false },
  { src: 'PP_Rock_Pile_Forest_Moss_05', id: 'pp-rock-pile', split: false },
  { src: 'PP_Grass_11', id: 'pp-grass-clump', split: false },
  { src: 'PP_Meadow_07', id: 'pp-meadow-patch', split: false },
  { src: 'PP_Daffodil_03', id: 'pp-daffodil', split: false },
  { src: 'PP_Sunflower_04', id: 'pp-sunflower', split: false },
  { src: 'PP_Mushroom_Fantasy_Orange_10', id: 'pp-mushroom-orange', split: false },
]

function loadMesh(file) {
  const buf = fs.readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const root = new FBXLoader().parse(ab, '')
  const geos = []
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry.clone()
    g.applyMatrix4(o.matrixWorld)
    // A MIRRORED NODE FLIPS HANDEDNESS AND `applyMatrix4` DOES NOT FIX WINDING.
    //
    // Several of the pack's sub-objects carry a negative-determinant transform.
    // Comparing each face normal against the authored vertex normals does NOT
    // catch it, because three transforms those normals by the inverse-transpose
    // and a mirror flips them too — geometry and normals end up consistently
    // inverted and the per-triangle test sees agreement. 2% of the tall birch
    // came through inside-out that way and the budget invariant flagged it.
    // The determinant is the honest signal.
    geos.push({ geo: g, mirrored: o.matrixWorld.determinant() < 0 })
  })
  if (!geos.length) throw new Error(`no mesh in ${file}`)
  return geos
}

/** Triangles as flat records, world space, indices resolved. */
function triangles(geos) {
  const out = []
  for (const { geo: g, mirrored } of geos) {
    const pos = g.attributes.position
    const nrm = g.attributes.normal
    const uv = g.attributes.uv
    const idx = g.index
    const n = idx ? idx.count : pos.count
    for (let i = 0; i < n; i += 3) {
      const a = idx ? idx.getX(i) : i
      const b = idx ? idx.getX(i + 1) : i + 1
      const c = idx ? idx.getX(i + 2) : i + 2
      const t = { v: [], n: [], u: 0, vv: 0, ymin: Infinity }
      for (const k of [a, b, c]) {
        t.v.push(pos.getX(k), pos.getY(k), pos.getZ(k))
        t.n.push(nrm ? nrm.getX(k) : 0, nrm ? nrm.getY(k) : 1, nrm ? nrm.getZ(k) : 0)
        t.ymin = Math.min(t.ymin, pos.getY(k))
        if (uv) { t.u += uv.getX(k) / 3; t.vv += uv.getY(k) / 3 }
      }
      // FIX THE WINDING AGAINST THE AUTHORED NORMALS.
      //
      // Some of the pack's meshes carry mirrored transforms, which flips the
      // handedness of the affected triangles: 2% of the tall birch came through
      // wound inside-out, and the budget invariant catches that because a
      // single-sided material culls them and the form renders hollow. The
      // authored vertex normals still point outward, so comparing the face
      // normal to their mean says which triangles to swap.
      if (mirrored) {
        for (const arr of [t.v, t.n]) {
          const tmp = arr.splice(3, 3)
          arr.splice(6, 0, ...tmp)
        }
        for (let q = 0; q < 9; q++) t.n[q] = -t.n[q]
      }
      const e1 = [t.v[3] - t.v[0], t.v[4] - t.v[1], t.v[5] - t.v[2]]
      const e2 = [t.v[6] - t.v[0], t.v[7] - t.v[1], t.v[8] - t.v[2]]
      const fn = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const an = [
        (t.n[0] + t.n[3] + t.n[6]) / 3,
        (t.n[1] + t.n[4] + t.n[7]) / 3,
        (t.n[2] + t.n[5] + t.n[8]) / 3,
      ]
      if (fn[0] * an[0] + fn[1] * an[1] + fn[2] * an[2] < 0) {
        for (const arr of [t.v, t.n]) {
          const tmp = arr.splice(3, 3)
          arr.splice(6, 0, ...tmp)
        }
      }
      out.push(t)
    }
  }
  return out
}

/** Group triangles by UV patch, then merge to `trunk` (lowest) + `foliage`. */
function split(tris) {
  const cells = new Map()
  for (const t of tris) {
    const k = `${Math.round(t.u * 24)},${Math.round(t.vv * 24)}`
    let e = cells.get(k)
    if (!e) { e = { tris: [], ymin: Infinity }; cells.set(k, e) }
    e.tris.push(t)
    e.ymin = Math.min(e.ymin, t.ymin)
  }
  const groups = [...cells.values()].sort((a, b) => a.ymin - b.ymin)
  // The patch that reaches lowest is the trunk; anything whose own ymin is
  // within 12% of the model's height of it belongs with it (bark on a birch is
  // split across several swatches).
  const all = tris.reduce((m, t) => Math.min(m, t.ymin), Infinity)
  const top = tris.reduce((m, t) => Math.max(m, Math.max(t.v[1], t.v[4], t.v[7])), -Infinity)
  const band = (top - all) * 0.12
  const trunk = []
  const foliage = []
  for (const g of groups) {
    if (g.ymin <= all + band && trunk.length < tris.length * 0.6) trunk.push(...g.tris)
    else foliage.push(...g.tris)
  }
  return foliage.length ? { trunk, foliage } : { trunk: [], foliage: trunk }
}

/** Weld, scale to metres, sit the base on y = 0, centre on XZ. */
function bake(tris, scale, drop, cx, cz) {
  const map = new Map()
  const P = []; const N = []; const I = []
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const x = (t.v[k * 3] - cx) * scale
      const y = (t.v[k * 3 + 1] - drop) * scale
      const z = (t.v[k * 3 + 2] - cz) * scale
      const nx = t.n[k * 3]; const ny = t.n[k * 3 + 1]; const nz = t.n[k * 3 + 2]
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)},${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)}`
      let i = map.get(key)
      if (i === undefined) {
        i = P.length / 3
        map.set(key, i)
        P.push(+x.toFixed(4), +y.toFixed(4), +z.toFixed(4))
        N.push(+nx.toFixed(3), +ny.toFixed(3), +nz.toFixed(3))
      }
      I.push(i)
    }
  }
  fixShellWinding(P, I)
  return { positions: P, normals: N, indices: I }
}

/**
 * Flip any connected shell whose signed volume is negative.
 *
 * The last line of defence, and the one that actually worked. Two cheaper tests
 * were tried on the tall birch and both missed it: comparing each face normal to
 * the authored vertex normals (geometry and normals are inverted CONSISTENTLY,
 * so the test sees agreement) and checking the node transform's determinant (the
 * offending sub-object is not mirrored). This measures the same quantity the
 * budget invariant does — six times the tetrahedron volume summed over a shell —
 * so if it passes here it passes there by construction.
 */
function fixShellWinding(P, I) {
  const n = P.length / 3
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]); parent[find(I[t + 1])] = a; parent[find(I[t + 2])] = a
  }
  const vol = new Map()
  const tris = new Map()
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t])
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]]
    const v =
      P[a * 3] * (P[b * 3 + 1] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3 + 1]) -
      P[a * 3 + 1] * (P[b * 3] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3]) +
      P[a * 3 + 2] * (P[b * 3] * P[c * 3 + 1] - P[b * 3 + 1] * P[c * 3])
    vol.set(r, (vol.get(r) ?? 0) + v)
    if (!tris.has(r)) tris.set(r, [])
    tris.get(r).push(t)
  }
  // SKIP SHEETS, exactly as the budget invariant does. An open surface has no
  // meaningful signed volume, so flipping one on the strength of its sign is a
  // coin toss — and it lost: the first version turned the young birch from
  // clean to 100% inside-out by inverting a shell that was never a solid.
  let flipped = 0
  for (const [r, v] of vol) {
    if (v >= 0) continue
    const ts = tris.get(r)
    let mnx = Infinity; let mny = Infinity; let mnz = Infinity
    let mxx = -Infinity; let mxy = -Infinity; let mxz = -Infinity
    for (const t of ts) {
      for (const k of [I[t], I[t + 1], I[t + 2]]) {
        mnx = Math.min(mnx, P[k * 3]); mxx = Math.max(mxx, P[k * 3])
        mny = Math.min(mny, P[k * 3 + 1]); mxy = Math.max(mxy, P[k * 3 + 1])
        mnz = Math.min(mnz, P[k * 3 + 2]); mxz = Math.max(mxz, P[k * 3 + 2])
      }
    }
    const box = (mxx - mnx) * (mxy - mny) * (mxz - mnz)
    if (Math.abs(v / 6) < Math.max(1e-9, box * 0.02)) continue
    for (const t of ts) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; flipped++ }
  }
  return flipped
}

fs.mkdirSync(OUT, { recursive: true })
let total = 0
for (const w of WANTED) {
  const file = path.join(DIR, `${w.src}.fbx`)
  if (!fs.existsSync(file)) { console.log(`  skip ${w.src} (missing)`); continue }
  const tris = triangles(loadMesh(file))
  let minY = Infinity; let maxY = -Infinity
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      minX = Math.min(minX, t.v[k * 3]); maxX = Math.max(maxX, t.v[k * 3])
      minY = Math.min(minY, t.v[k * 3 + 1]); maxY = Math.max(maxY, t.v[k * 3 + 1])
      minZ = Math.min(minZ, t.v[k * 3 + 2]); maxZ = Math.max(maxZ, t.v[k * 3 + 2])
    }
  }
  // The pack authors in centimetres: a tree measures ~700 units tall.
  const scale = 0.01
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const parts = []
  if (w.split) {
    const { trunk, foliage } = split(tris)
    if (trunk.length) parts.push({ slot: 'trunk', ...bake(trunk, scale, minY, cx, cz) })
    parts.push({ slot: 'foliage', ...bake(foliage, scale, minY, cx, cz) })
  } else {
    parts.push({ slot: 'body', ...bake(tris, scale, minY, cx, cz) })
  }
  const doc = {
    id: w.id, source: `${w.src}.fbx`,
    height: +((maxY - minY) * scale).toFixed(3),
    footprint: +(Math.max(maxX - minX, maxZ - minZ) * scale).toFixed(3),
    parts,
  }
  const out = path.join(OUT, `${w.id}.json`)
  fs.writeFileSync(out, JSON.stringify(doc))
  const kb = (fs.statSync(out).size / 1024) | 0
  const tri = parts.reduce((n, p) => n + p.indices.length / 3, 0)
  total += tri
  console.log(`  ${w.id.padEnd(20)} ${String(tri).padStart(5)} tris  h ${doc.height.toFixed(2)} m  ` +
    `${parts.map((p) => `${p.slot}:${p.indices.length / 3}`).join(' ')}  ${kb} kB`)
}
console.log(`\n${total} triangles imported into ${OUT}/`)
