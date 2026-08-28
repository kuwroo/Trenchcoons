import * as THREE from 'three';

/**
 * Single grass clump card — one plane for a silhouette texture
 * (Vecteezy-style “one grass bunch” per instance).
 * UV: u across, v = 0 base → 1 tip (for wind root lock).
 */
export function createSilhouetteCardGeometry(width = 0.9, height = 0.75) {
  // Simple vertical plane in XY, facing +Z
  const hw = width * 0.5;
  const positions = new Float32Array([
    -hw, 0, 0,
    hw, 0, 0,
    hw, height, 0,
    -hw, height, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const indices = [0, 1, 2, 0, 2, 3];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Crossed silhouette (two cards @ 90°) — same clump icon, readable from all angles.
 * Avoids the “paper thin line” when viewed edge-on.
 */
export function createSilhouetteCrossGeometry(width = 0.9, height = 0.75) {
  const hw = width * 0.5;
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];

  const addPlane = (yaw) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const base = positions.length / 3;
    const corners = [
      [-hw, 0],
      [hw, 0],
      [hw, height],
      [-hw, height],
    ];
    const uvC = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const lx = corners[i][0];
      const ly = corners[i][1];
      positions.push(lx * c, ly, -lx * s);
      uvs.push(uvC[i][0], uvC[i][1]);
      // outward-ish normal
      normals.push(s, 0, c);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  addPlane(0);
  addPlane(Math.PI * 0.5);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function createFlatBunchGeometry(bladeCount, width = 0.9, height = 0.75) {
  return createSilhouetteCrossGeometry(width * 2.2, height);
}

export function createClumpGeometry(bladeCount, width = 1.0, height = 0.8) {
  return createSilhouetteCrossGeometry(width * 2.4, height);
}

export function createBladeGeometry(segments, width = 0.5, height = 0.7) {
  return createSilhouetteCrossGeometry(width * 2, height);
}
