// Crossed silhouette cards — port of vendor/procedural-grass/src/bladeGeometry.js.
//
// Each instance is one Vecteezy-style grass clump: two vertical planes at 90°,
// so an edge-on view still reads as a tuft. UV.v = 0 at the root, 1 at the tip,
// which is what the wind / crush / kart-push weights read.

import * as THREE from 'three/webgpu'

/** Two planes @ 90°, shared UVs (v = height). Width/height in metres. */
export function createSilhouetteCrossGeometry(
  width = 0.9, height = 0.75,
): THREE.BufferGeometry {
  const hw = width * 0.5
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  const addPlane = (yaw: number): void => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const base = positions.length / 3
    const corners: [number, number][] = [
      [-hw, 0], [hw, 0], [hw, height], [-hw, height],
    ]
    const uvC: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    for (let i = 0; i < 4; i++) {
      const lx = corners[i]![0]
      const ly = corners[i]![1]
      positions.push(lx * c, ly, -lx * s)
      uvs.push(uvC[i]![0], uvC[i]![1])
      normals.push(s, 0.35, c)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  addPlane(0)
  addPlane(Math.PI * 0.5)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
