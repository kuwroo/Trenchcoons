// Geometry helpers for the kart. Chunky rounded forms, Capy Castaway form
// language (ART_BIBLE §6: "chunky, rounded, low-poly forms. Volume reads from
// silhouette alone").
//
// No `three/addons` geometry is used here on purpose: the addon geometries
// import from `three`, not `three/webgpu`, which pulls a SECOND copy of the
// core library into the bundle and gives us two incompatible BufferGeometry
// classes. Twenty lines of vertex maths is cheaper than that.

import * as THREE from 'three/webgpu'
import { mergeParts, placeGeometry } from '../assets/mesh'

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

/**
 * Cylinder with its axis along X, so a rotation about X spins it like a wheel —
 * plus tread lugs, which are the whole point.
 *
 * A bare cylinder is rotationally symmetric, and the painterly brush field is
 * sampled from `positionWorld`, so the mottle is world-projected and SLIDES
 * ACROSS the tyre instead of turning with it. The wheel therefore had no
 * rotation cue whatsoever: `w.spin` was simulated correctly from contact
 * velocity and was invisible on screen. At 35 m/s the only cue was 14-gon facet
 * shading at 83.6 deg per frame — 3.25 facets, well past Nyquist, so it aliased
 * to a static blur, and at 8.7 m/s it sat right on the wagon-wheel ambiguity.
 *
 * Lugs are merged into the same geometry, so this stays zero extra draw calls
 * on a kart that is already drawn once per frame plus once per shadow cascade.
 */
export function wheelGeometry(radius: number, width: number, segments = 14): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    (() => {
      const g = new THREE.CylinderGeometry(radius, radius, width, segments, 1)
      g.rotateZ(Math.PI * 0.5)
      return g
    })(),
  ]

  // Shallow blocks around the circumference. Nine is coprime with the 14 facets,
  // so lugs and facets do not beat against each other into a static pattern.
  const LUGS = 9
  const lugH = radius * 0.13
  for (let i = 0; i < LUGS; i++) {
    const a = (i / LUGS) * Math.PI * 2
    const g = new THREE.BoxGeometry(width * 0.72, lugH, radius * 0.46)
    place(
      g,
      0, Math.sin(a) * (radius - lugH * 0.35), Math.cos(a) * (radius - lugH * 0.35),
      -a, 0, 0,
    )
    parts.push(g)
  }

  // Hub cap bar. Gives a low-speed rotation read where individual lugs are still
  // resolvable but the eye wants one strong feature to track.
  const bar = new THREE.BoxGeometry(width * 1.06, radius * 0.17, radius * 0.9)
  place(bar, 0, 0, 0, 0.6, 0, 0)
  parts.push(bar)

  return mergeGeometries(parts)
}

/**
 * Position a geometry in its parent's space, in place.
 *
 * Used to build a dressed part — flutes, tape, print — as ONE geometry that is
 * then merged, so the extra form on the box costs vertices and not draw calls.
 * The kart is drawn five times a frame (once for the frame, once per shadow
 * cascade), so a draw call here is worth five.
 */
export const place = placeGeometry

/**
 * Merge indexed geometries that carry position and normal.
 *
 * `three/addons/utils/BufferGeometryUtils` would do this, and importing it is
 * the one thing this file is not allowed to do — see the header: the addons
 * resolve `three`, not `three/webgpu`, and pull a second copy of the core
 * library in with two incompatible BufferGeometry classes.
 *
 * The implementation lives in src/assets/mesh.ts now, because the scatter
 * library needs the identical merge and two copies of it would drift. Position
 * and normal are the only attributes the painterly material reads (it works
 * from `positionLocal` / `positionWorld` / `normalWorld`, never from a UV), so
 * everything else is dropped on purpose rather than carried dead.
 *
 * `requireIndexed` keeps this file's original contract: an unindexed part here
 * means a geometry reached the merge by a route that was not meant to.
 */
export function mergeGeometries(
  parts: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  return mergeParts(parts, { requireIndexed: true })
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
