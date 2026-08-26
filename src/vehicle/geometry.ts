// Geometry helpers for the kart. Chunky rounded forms, Capy Castaway form
// language (ART_BIBLE §6: "chunky, rounded, low-poly forms. Volume reads from
// silhouette alone").
//
// No `three/addons` geometry is used here on purpose: the addon geometries
// import from `three`, not `three/webgpu`, which pulls a SECOND copy of the
// core library into the bundle and gives us two incompatible BufferGeometry
// classes. Twenty lines of vertex maths is cheaper than that.

import * as THREE from 'three/webgpu'

/**
 * Rounded box, built by projecting a subdivided box onto the rounded-box
 * surface — the same clamp-then-offset the SDF uses.
 *
 * Normals are computed analytically rather than by `computeVertexNormals`,
 * because BoxGeometry splits vertices per face: averaging would leave a hard
 * crease exactly along the rounded edges, which is the one place the form needs
 * to be smooth. The flat faces keep their exact face normal, so the 3-stop ramp
 * still reads them as single stops.
 */
export function roundedBox(
  width: number, height: number, depth: number, radius: number, segments = 4,
): THREE.BufferGeometry {
  const hx = width * 0.5
  const hy = height * 0.5
  const hz = depth * 0.5
  const r = Math.min(radius, hx, hy, hz)
  const geo = new THREE.BoxGeometry(width, height, depth, segments, segments, segments)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const nrm = geo.attributes.normal as THREE.BufferAttribute
  const ix = hx - r
  const iy = hy - r
  const iz = hz - r
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const cx = Math.max(-ix, Math.min(ix, x))
    const cy = Math.max(-iy, Math.min(iy, y))
    const cz = Math.max(-iz, Math.min(iz, z))
    const dx = x - cx
    const dy = y - cy
    const dz = z - cz
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) continue
    const s = r / len
    pos.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s)
    nrm.setXYZ(i, dx / len, dy / len, dz / len)
  }
  pos.needsUpdate = true
  nrm.needsUpdate = true
  geo.computeBoundingSphere()
  return geo
}

/** Low-poly blob. The raccoon primitive. */
export function blob(radius: number, detail = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, detail, Math.max(4, detail >> 1))
}

/** Cylinder with its axis along X, so a rotation about X spins it like a wheel. */
export function wheelGeometry(radius: number, width: number, segments = 14): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, width, segments, 1)
  geo.rotateZ(Math.PI * 0.5)
  return geo
}

const _mat = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _eul = new THREE.Euler(0, 0, 0, 'YXZ')
const _vec = new THREE.Vector3()
const _scl = new THREE.Vector3(1, 1, 1)

/**
 * Position a geometry in its parent's space, in place.
 *
 * Used to build a dressed part — flutes, tape, print — as ONE geometry that is
 * then merged, so the extra form on the box costs vertices and not draw calls.
 * The kart is drawn five times a frame (once for the frame, once per shadow
 * cascade), so a draw call here is worth five.
 */
export function place(
  geo: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  _eul.set(rx, ry, rz)
  _quat.setFromEuler(_eul)
  geo.applyMatrix4(_mat.compose(_vec.set(x, y, z), _quat, _scl.set(sx, sy, sz)))
  return geo
}

/**
 * Merge indexed geometries that carry position and normal.
 *
 * `three/addons/utils/BufferGeometryUtils` would do this, and importing it is
 * the one thing this file is not allowed to do — see the header: the addons
 * resolve `three`, not `three/webgpu`, and pull a second copy of the core
 * library in with two incompatible BufferGeometry classes. Position and normal
 * are the only attributes the painterly material reads (it works from
 * `positionLocal` / `positionWorld` / `normalWorld`, never from a UV), so
 * everything else is dropped on purpose rather than carried dead.
 */
export function mergeGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertices = 0
  let indices = 0
  for (const p of parts) {
    const pos = p.getAttribute('position')
    if (!pos) throw new Error('mergeGeometries: part has no position attribute')
    if (!p.index) throw new Error('mergeGeometries: part is not indexed')
    vertices += pos.count
    indices += p.index.count
  }
  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  let v = 0
  let i = 0
  for (const p of parts) {
    const pos = p.getAttribute('position')
    const nrm = p.getAttribute('normal')
    const idx = p.index as THREE.BufferAttribute
    for (let k = 0; k < pos.count; k++) {
      position[(v + k) * 3] = pos.getX(k)
      position[(v + k) * 3 + 1] = pos.getY(k)
      position[(v + k) * 3 + 2] = pos.getZ(k)
      if (nrm) {
        normal[(v + k) * 3] = nrm.getX(k)
        normal[(v + k) * 3 + 1] = nrm.getY(k)
        normal[(v + k) * 3 + 2] = nrm.getZ(k)
      }
    }
    for (let k = 0; k < idx.count; k++) index[i + k] = v + idx.getX(k)
    v += pos.count
    i += idx.count
    p.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(position, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  out.computeBoundingSphere()
  return out
}

/**
 * A batch of identically-shaped parts posed per frame from TRS.
 *
 * The kart is ~11 parts and the shadow pass draws the whole scene four times,
 * one per cascade, so every part that stays a separate mesh costs five draw
 * calls against a 1500 budget. Wheels, ears, eyes and flaps are all
 * multiplicities of one shape, so they batch.
 */
export class PosedInstances {
  readonly mesh: THREE.InstancedMesh
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ')
  private readonly one = new THREE.Vector3(1, 1, 1)

  constructor(
    geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, count)
    this.mesh.name = name
    // The kart is always within a few metres of the chase camera; culling it
    // per-instance costs matrix work to save nothing.
    this.mesh.frustumCulled = false
  }

  set(
    i: number, pos: THREE.Vector3,
    rx = 0, ry = 0, rz = 0, scale: THREE.Vector3 = this.one,
  ): void {
    this.e.set(rx, ry, rz)
    this.q.setFromEuler(this.e)
    this.mesh.setMatrixAt(i, this.m.compose(pos, this.q, scale))
  }

  /** Call once after all `set()` calls for the frame. */
  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
