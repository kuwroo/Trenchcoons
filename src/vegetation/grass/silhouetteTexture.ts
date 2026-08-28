// Alpha map for silhouette clumps.
//
// Prefers public/grass-clump.png (cleaned offline from the procedural-grass
// prototype). Until it loads, a procedural stand-in keeps the boot synchronous.

import * as THREE from 'three/webgpu'

function proceduralSilhouette(size = 512): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const cx = size * 0.5
  const cy = size * 0.62
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      let a = 0
      const tips = [
        [0.0, 0.0, 0.22, 0.55],
        [-0.18, 0.05, 0.16, 0.48],
        [0.18, 0.04, 0.16, 0.48],
        [-0.32, 0.12, 0.12, 0.38],
        [0.32, 0.12, 0.12, 0.38],
        [0.0, 0.15, 0.28, 0.35],
      ] as const
      for (const [ox, oy, rx, ry] of tips) {
        const dx = (x - cx) / size - ox
        const dy = (cy - y) / size - oy
        const e = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry)
        a = Math.max(a, 1 - Math.min(1, e))
      }
      const ground = Math.max(0, 1 - (size - 1 - y) / (size * 0.12))
      a *= ground
      const g = Math.round(40 + a * 140)
      data[i] = 30
      data[i + 1] = g
      data[i + 2] = 40
      data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  tex.flipY = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  return tex
}

/**
 * Paint the loaded PNG into the existing DataTexture's Uint8Array so WebGPU
 * never sees an HTMLImageElement swap (which throws writeTexture overload).
 */
function blitImageIntoDataTexture(tex: THREE.DataTexture, img: HTMLImageElement): void {
  const w = tex.image.width as number
  const h = tex.image.height as number
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const src = ctx.getImageData(0, 0, w, h).data
  const dst = tex.image.data as Uint8Array
  dst.set(src)
  tex.needsUpdate = true
}

let shared: THREE.DataTexture | null = null

export function grassAlphaMap(): THREE.Texture {
  if (shared) return shared
  shared = proceduralSilhouette()

  const img = new Image()
  img.onload = () => {
    if (!shared) return
    blitImageIntoDataTexture(shared, img)
  }
  img.onerror = () => {
    console.warn('[grass] /grass-clump.png missing; using procedural silhouette')
  }
  img.src = '/grass-clump.png'
  return shared
}
