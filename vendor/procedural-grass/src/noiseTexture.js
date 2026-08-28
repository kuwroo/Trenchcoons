import * as THREE from 'three';

/**
 * Large soft colour-patch map for A+-style grass variation.
 * Low-frequency blobs + cellular cells → meadow patches, not fine grain.
 */
export function createColorNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);

  const hash2 = (ix, iy) => {
    const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  const valueNoise = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = hash2(x0, y0);
    const b = hash2(x0 + 1, y0);
    const c = hash2(x0, y0 + 1);
    const d = hash2(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // few octaves only → broad shapes
  const fbmLow = (x, y) => {
    let v = 0;
    let a = 0.55;
    let f = 1;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      v += a * valueNoise(x * f, y * f);
      n += a;
      a *= 0.5;
      f *= 2.0;
    }
    return v / n;
  };

  // cellular / Worley-ish: distance to nearest random point in cell grid
  const worley = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let minD = 1e9;
    let minD2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        const cy = yi + oy;
        const px = cx + hash2(cx, cy);
        const py = cy + hash2(cx + 19, cy + 47);
        const dx = px - x;
        const dy = py - y;
        const d = dx * dx + dy * dy;
        if (d < minD) {
          minD2 = minD;
          minD = d;
        } else if (d < minD2) {
          minD2 = d;
        }
      }
    }
    const d1 = Math.sqrt(minD);
    const d2 = Math.sqrt(minD2);
    // F2-F1 style soft cell edges
    return THREE.MathUtils.clamp(d2 - d1, 0, 1);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // large meadow blobs (very low frequency across texture)
      const blobs = fbmLow(u * 2.2, v * 2.2);
      // organic cells ~ handful of patches across the map
      const cells = worley(u * 5.5, v * 5.5);
      // combine: broad tone + cell structure
      let patch = blobs * 0.55 + (1.0 - cells) * 0.45;
      // soft threshold → clearer patch regions (not salt-and-pepper)
      patch = smooth(THREE.MathUtils.clamp((patch - 0.32) / 0.45, 0, 1));

      // second layer of slightly offset patches for R vs G variety
      const blobs2 = fbmLow(u * 2.0 + 3.1, v * 2.0 + 1.7);
      const cells2 = worley(u * 4.2 + 1.3, v * 4.2 - 0.8);
      let patch2 = blobs2 * 0.5 + (1.0 - cells2) * 0.5;
      patch2 = smooth(THREE.MathUtils.clamp((patch2 - 0.35) / 0.4, 0, 1));

      const i = (y * size + x) * 4;
      data[i] = Math.floor(THREE.MathUtils.clamp(patch, 0, 1) * 255);
      data[i + 1] = Math.floor(THREE.MathUtils.clamp(patch2, 0, 1) * 255);
      data[i + 2] = Math.floor(THREE.MathUtils.clamp((patch + patch2) * 0.5, 0, 1) * 255);
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
