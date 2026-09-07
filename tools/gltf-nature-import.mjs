// Quaternius Stylized Nature (GLTF) -> compact mesh JSON, run offline.
//
//   npm run nature:import
//   NATURE_DIR=/path/to/stylized-nature node tools/gltf-nature-import.mjs
//
// Same contract as tools/fbx-import.mjs: scatterAsset() is synchronous and
// deterministic, so geometry is baked into assets/meshes/*.json and consumed by
// the `imported` generator. Material names carry the trunk/foliage split
// (Bark_* / Leaves_*), which is cleaner than the Poly Pizza UV-patch recovery.
//
// Default source is the overgrown-portfolio guide's vendored kit.
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env['NATURE_DIR']
  ?? '/Users/chloeongsiyi/overgrown-portfolio/public/models/stylized-nature'
const OUT = 'assets/meshes'

/**
 * source stem (no extension) -> { id, split }.
 * `split: true` maps Bark_* materials to trunk and Leaves_* / Leaf_* to foliage.
 */
const WANTED = [
  { src: 'CommonTree_1', id: 'qn-common-1', split: true },
  { src: 'CommonTree_2', id: 'qn-common-2', split: true },
  { src: 'CommonTree_3', id: 'qn-common-3', split: true },
  { src: 'CommonTree_4', id: 'qn-common-4', split: true },
  { src: 'CommonTree_5', id: 'qn-common-5', split: true },
  { src: 'Pine_1', id: 'qn-pine-1', split: true },
  { src: 'Pine_2', id: 'qn-pine-2', split: true },
  { src: 'Pine_3', id: 'qn-pine-3', split: true },
  { src: 'TwistedTree_1', id: 'qn-twisted-1', split: true },
  { src: 'TwistedTree_2', id: 'qn-twisted-2', split: true },
  { src: 'Bush_Common', id: 'qn-bush', split: false },
  { src: 'Rock_Medium_1', id: 'qn-rock-1', split: false },
  { src: 'Rock_Medium_2', id: 'qn-rock-2', split: false },
  { src: 'Rock_Medium_3', id: 'qn-rock-3', split: false },
  { src: 'Pebble_Round_1', id: 'qn-pebble-1', split: false },
  { src: 'Pebble_Round_2', id: 'qn-pebble-2', split: false },
  { src: 'Pebble_Round_3', id: 'qn-pebble-3', split: false },
  { src: 'Clover_1', id: 'qn-clover-1', split: false },
  { src: 'Clover_2', id: 'qn-clover-2', split: false },
  { src: 'Mushroom_Common', id: 'qn-mushroom', split: false },
]

function slotForMaterial(name) {
  const n = (name || '').toLowerCase()
  if (/bark/.test(n)) return 'trunk'
  if (/leaf|leave|pine|foliage|twisted|clover|grass/.test(n)) return 'foliage'
  return 'body'
}

function readAccessor(gltf, bin, accessorIndex, out) {
  const acc = gltf.accessors[accessorIndex]
  const view = gltf.bufferViews[acc.bufferView]
  const componentType = acc.componentType
  const type = acc.type
  const count = acc.count
  const byteOffset = (view.byteOffset || 0) + (acc.byteOffset || 0)
  const comps = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 0
  if (!comps) throw new Error(`unsupported accessor type ${type}`)
  const Typed = componentType === 5126 ? Float32Array
    : componentType === 5123 ? Uint16Array
    : componentType === 5125 ? Uint32Array
    : componentType === 5121 ? Uint8Array
    : null
  if (!Typed) throw new Error(`unsupported componentType ${componentType}`)
  const stride = view.byteStride || Typed.BYTES_PER_ELEMENT * comps
  for (let i = 0; i < count; i++) {
    const o = byteOffset + i * stride
    const slice = new Typed(bin.buffer, bin.byteOffset + o, comps)
    for (let c = 0; c < comps; c++) out.push(slice[c])
  }
  return count
}

function mat4Mul(a, b) {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3]
    }
  }
  return o
}

function mat4FromNode(node) {
  if (node.matrix && node.matrix.length === 16) return Float64Array.from(node.matrix)
  const t = node.translation || [0, 0, 0]
  const s = node.scale || [1, 1, 1]
  const q = node.rotation || [0, 0, 0, 1]
  const [x, y, z, w] = q
  const xx = x * x; const yy = y * y; const zz = z * z
  const xy = x * y; const xz = x * z; const yz = y * z
  const wx = w * x; const wy = w * y; const wz = w * z
  const r = new Float64Array([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ])
  const S = new Float64Array([
    s[0], 0, 0, 0,
    0, s[1], 0, 0,
    0, 0, s[2], 0,
    0, 0, 0, 1,
  ])
  const T = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    t[0], t[1], t[2], 1,
  ])
  return mat4Mul(T, mat4Mul(r, S))
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

function transformDir(m, x, y, z) {
  const dx = m[0] * x + m[4] * y + m[8] * z
  const dy = m[1] * x + m[5] * y + m[9] * z
  const dz = m[2] * x + m[6] * y + m[10] * z
  const len = Math.hypot(dx, dy, dz) || 1
  return [dx / len, dy / len, dz / len]
}

function det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  )
}

/** Collect world-space triangles tagged with a material slot. */
function loadGltf(file) {
  const gltf = JSON.parse(fs.readFileSync(file, 'utf8'))
  const binUri = gltf.buffers?.[0]?.uri
  if (!binUri) throw new Error(`${file}: no buffer`)
  const bin = fs.readFileSync(path.join(path.dirname(file), binUri))
  const mats = (gltf.materials || []).map((m) => m.name || '')
  const tris = []

  const visit = (nodeIndex, parent) => {
    const node = gltf.nodes[nodeIndex]
    const local = mat4FromNode(node)
    const world = parent ? mat4Mul(parent, local) : local
    const mirrored = det3(world) < 0
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh]
      for (const prim of mesh.primitives) {
        const matName = mats[prim.material] || ''
        const slot = slotForMaterial(matName)
        const pos = []
        const nrm = []
        readAccessor(gltf, bin, prim.attributes.POSITION, pos)
        if (prim.attributes.NORMAL !== undefined) {
          readAccessor(gltf, bin, prim.attributes.NORMAL, nrm)
        }
        const idx = []
        if (prim.indices !== undefined) readAccessor(gltf, bin, prim.indices, idx)
        else {
          for (let i = 0; i < pos.length / 3; i++) idx.push(i)
        }
        for (let t = 0; t < idx.length; t += 3) {
          const a = idx[t]; const b = idx[t + 1]; const c = idx[t + 2]
          const tRec = { v: [], n: [], slot, ymin: Infinity }
          for (const k of [a, b, c]) {
            const [x, y, z] = transformPoint(world, pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2])
            let nx = 0; let ny = 1; let nz = 0
            if (nrm.length) {
              ;[nx, ny, nz] = transformDir(world, nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2])
            }
            tRec.v.push(x, y, z)
            tRec.n.push(nx, ny, nz)
            tRec.ymin = Math.min(tRec.ymin, y)
          }
          if (mirrored) {
            for (const arr of [tRec.v, tRec.n]) {
              const tmp = arr.splice(3, 3)
              arr.splice(6, 0, ...tmp)
            }
            for (let q = 0; q < 9; q++) tRec.n[q] = -tRec.n[q]
          }
          // Fix winding against authored normals when they disagree.
          const e1 = [tRec.v[3] - tRec.v[0], tRec.v[4] - tRec.v[1], tRec.v[5] - tRec.v[2]]
          const e2 = [tRec.v[6] - tRec.v[0], tRec.v[7] - tRec.v[1], tRec.v[8] - tRec.v[2]]
          const fn = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
          ]
          const an = [
            (tRec.n[0] + tRec.n[3] + tRec.n[6]) / 3,
            (tRec.n[1] + tRec.n[4] + tRec.n[7]) / 3,
            (tRec.n[2] + tRec.n[5] + tRec.n[8]) / 3,
          ]
          if (fn[0] * an[0] + fn[1] * an[1] + fn[2] * an[2] < 0) {
            for (const arr of [tRec.v, tRec.n]) {
              const tmp = arr.splice(3, 3)
              arr.splice(6, 0, ...tmp)
            }
          }
          tris.push(tRec)
        }
      }
    }
    for (const child of node.children || []) visit(child, world)
  }

  const scene = gltf.scenes[gltf.scene ?? 0]
  for (const root of scene.nodes) visit(root, null)
  if (!tris.length) throw new Error(`no triangles in ${file}`)
  return tris
}

function bake(tris, drop, cx, cz) {
  const map = new Map()
  const P = []; const N = []; const I = []
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const x = t.v[k * 3] - cx
      const y = t.v[k * 3 + 1] - drop
      const z = t.v[k * 3 + 2] - cz
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
  return { positions: P, normals: N, indices: I }
}

fs.mkdirSync(OUT, { recursive: true })
if (!fs.existsSync(DIR)) {
  console.error(`NATURE_DIR missing: ${DIR}`)
  process.exit(1)
}

let total = 0
for (const w of WANTED) {
  const file = path.join(DIR, `${w.src}.gltf`)
  if (!fs.existsSync(file)) { console.log(`  skip ${w.src} (missing)`); continue }
  const tris = loadGltf(file)
  let minY = Infinity; let maxY = -Infinity
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      minX = Math.min(minX, t.v[k * 3]); maxX = Math.max(maxX, t.v[k * 3])
      minY = Math.min(minY, t.v[k * 3 + 1]); maxY = Math.max(maxY, t.v[k * 3 + 1])
      minZ = Math.min(minZ, t.v[k * 3 + 2]); maxZ = Math.max(maxZ, t.v[k * 3 + 2])
    }
  }
  // Quaternius kit is already in metres.
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const bySlot = new Map()
  for (const t of tris) {
    const slot = w.split ? t.slot : 'body'
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot).push(t)
  }
  // If a "split" asset somehow only has one slot, still emit it.
  if (w.split && bySlot.has('foliage') && !bySlot.has('trunk')) {
    // Leaves-only bush-like tree: keep as foliage only.
  }
  const parts = []
  for (const slot of ['trunk', 'foliage', 'body']) {
    const list = bySlot.get(slot)
    if (!list?.length) continue
    parts.push({ slot, ...bake(list, minY, cx, cz) })
  }
  if (!parts.length) throw new Error(`${w.id}: no parts`)
  const doc = {
    id: w.id,
    source: `${w.src}.gltf`,
    height: +((maxY - minY)).toFixed(3),
    footprint: +(Math.max(maxX - minX, maxZ - minZ)).toFixed(3),
    parts,
  }
  const out = path.join(OUT, `${w.id}.json`)
  fs.writeFileSync(out, JSON.stringify(doc))
  const kb = (fs.statSync(out).size / 1024) | 0
  const tri = parts.reduce((n, p) => n + p.indices.length / 3, 0)
  total += tri
  console.log(`  ${w.id.padEnd(16)} ${String(tri).padStart(5)} tris  h ${doc.height.toFixed(2)} m  ` +
    `${parts.map((p) => `${p.slot}:${p.indices.length / 3}`).join(' ')}  ${kb} kB`)
}
console.log(`\n${total} triangles imported into ${OUT}/ from ${DIR}`)
