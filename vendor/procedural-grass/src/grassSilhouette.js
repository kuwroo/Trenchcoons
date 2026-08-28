import * as THREE from 'three';

/**
 * Improved white-background removal for grass icons:
 * - green chroma key
 * - corner flood-fill of white bg
 * - dilate/erode hole fill
 * - soft edge blur
 */
export function removeWhiteBackgroundToAlpha(imageData) {
  const { data, width: w, height: h } = imageData;
  const alpha = new Uint8Array(w * h);

  const lumAt = (i) => (data[i] + data[i + 1] + data[i + 2]) / 3;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (r + g + b) / 3;
      const idx = y * w + x;

      const nearWhite =
        lum > 240 && Math.abs(r - g) < 28 && Math.abs(g - b) < 28 && Math.abs(r - b) < 28;
      const pureWhite = r > 250 && g > 250 && b > 250;
      const greenGrass = g > 75 && g >= r * 0.82 && g >= b * 0.72 && lum < 248;

      if (greenGrass && !pureWhite) {
        // Soften near-white greens at edge of icon
        const edge = Math.min(1, Math.max(0, (245 - lum) / 40));
        alpha[idx] = Math.round(255 * Math.max(edge, greenGrass ? 1 : 0));
        if (lum < 240) alpha[idx] = 255;
      } else if (nearWhite || pureWhite || g < 70) {
        alpha[idx] = 0;
      } else {
        const score = g - Math.max(r, b);
        alpha[idx] = score > 20 ? 255 : score > 5 ? 160 : 0;
      }
    }
  }

  // Flood-fill background from image borders (force white regions to transparent)
  const vis = new Uint8Array(w * h);
  const q = [];
  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const id = y * w + x;
    if (vis[id]) return;
    const i = id * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (r + g + b) / 3;
    // only flood through bright/white-ish pixels
    if (lum < 205 && !(r > 215 && g > 215 && b > 215)) return;
    vis[id] = 1;
    alpha[id] = 0;
    q.push(x, y);
  };
  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }
  for (let qi = 0; qi < q.length; ) {
    const x = q[qi++];
    const y = q[qi++];
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  // Morphological close (fill pinholes in leaves)
  const dilate = (src) => {
    const dst = new Uint8Array(src.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            m = Math.max(m, src[(y + dy) * w + (x + dx)]);
          }
        }
        dst[y * w + x] = m;
      }
    }
    return dst;
  };
  const erode = (src) => {
    const dst = new Uint8Array(src.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            m = Math.min(m, src[(y + dy) * w + (x + dx)]);
          }
        }
        dst[y * w + x] = m;
      }
    }
    return dst;
  };
  let a2 = dilate(alpha);
  a2 = dilate(a2);
  a2 = erode(a2);
  a2 = erode(a2);

  // Soft 3x3 blur on alpha for anti-aliased edges
  const soft = new Uint8Array(a2.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += a2[(y + dy) * w + (x + dx)];
        }
      }
      soft[y * w + x] = Math.round(s / 9);
    }
  }

  // Write back as white RGB + alpha
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    data[p] = 255;
    data[p + 1] = 255;
    data[p + 2] = 255;
    data[p + 3] = soft[i];
  }
  return imageData;
}

export function createGrassSilhouetteTexture(size = 512) {
  // Prefer pre-baked high-quality PNG if already loaded via TextureLoader path
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';

  const X = (u) => u * size;
  const Y = (v) => (1 - v) * size;

  ctx.beginPath();
  ctx.moveTo(X(0.12), Y(0.0));
  ctx.lineTo(X(0.12), Y(0.12));
  ctx.bezierCurveTo(X(0.3), Y(0.2), X(0.7), Y(0.2), X(0.88), Y(0.12));
  ctx.lineTo(X(0.88), Y(0.0));
  ctx.closePath();
  ctx.fill();

  function blade(baseX, tipX, tipV, baseW) {
    ctx.beginPath();
    ctx.moveTo(X(baseX - baseW), Y(0.02));
    ctx.quadraticCurveTo(X(baseX - baseW * 0.35), Y(tipV * 0.55), X(tipX), Y(tipV));
    ctx.quadraticCurveTo(X(baseX + baseW * 0.35), Y(tipV * 0.55), X(baseX + baseW), Y(0.02));
    ctx.closePath();
    ctx.fill();
  }

  blade(0.22, 0.14, 0.58, 0.055);
  blade(0.28, 0.22, 0.72, 0.05);
  blade(0.34, 0.3, 0.86, 0.055);
  blade(0.4, 0.38, 0.94, 0.055);
  blade(0.46, 0.46, 1.0, 0.06);
  blade(0.5, 0.5, 0.98, 0.055);
  blade(0.54, 0.54, 1.0, 0.06);
  blade(0.6, 0.62, 0.92, 0.055);
  blade(0.66, 0.7, 0.84, 0.05);
  blade(0.72, 0.78, 0.7, 0.05);
  blade(0.78, 0.86, 0.56, 0.045);
  blade(0.36, 0.34, 0.55, 0.035);
  blade(0.64, 0.66, 0.52, 0.035);
  blade(0.48, 0.47, 0.7, 0.04);
  blade(0.18, 0.08, 0.42, 0.04);
  blade(0.84, 0.94, 0.4, 0.04);

  const img = ctx.getImageData(0, 0, size, size);
  removeWhiteBackgroundToAlpha(img);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load pre-baked PNG (preferred) or JPG with improved bg removal.
 */
export async function loadGrassSilhouetteFromUrl(url) {
  // Prefer clean PNG next to ref
  const preferPng = url.replace(/grass-clump-ref\.jpe?g$/i, 'grass-clump.png');
  const urls = preferPng !== url ? [preferPng, url] : [url];

  for (const u of urls) {
    try {
      const tex = await loadOne(u, u.endsWith('.png'));
      if (tex) return tex;
    } catch {
      /* try next */
    }
  }
  throw new Error('silhouette load failed');
}

function loadOne(url, isPng) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      const scale = Math.min(size / img.width, size / img.height) * 0.94;
      const w = img.width * scale;
      const h = img.height * scale;
      const ox = (size - w) / 2;
      const oy = (size - h) / 2 + size * 0.02;
      ctx.drawImage(img, ox, oy, w, h);

      if (isPng) {
        // Already has alpha from offline process — just normalize RGB to white
        const data = ctx.getImageData(0, 0, size, size);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3];
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = a > 20 ? a : 0;
        }
        ctx.putImageData(data, 0, 0);
      } else {
        const data = ctx.getImageData(0, 0, size, size);
        removeWhiteBackgroundToAlpha(data);
        ctx.putImageData(data, 0, 0);
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      tex.premultiplyAlpha = false;
      resolve(tex);
    };
    img.onerror = () => reject(new Error('fail ' + url));
    img.src = url + (url.includes('?') ? '&' : '?') + 'v=2';
  });
}
