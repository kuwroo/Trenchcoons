import * as THREE from 'three/webgpu'

/**
 * The baked Voronoi cell texture the water surface is built on.
 *
 * WHY A TEXTURE AND NOT `mx_worley_noise_vec2`. The procedural version this
 * replaces could not give a cell an IDENTITY. Worley returns distances, so the
 * only interior tone available was a low-frequency noise laid over the top,
 * and neighbouring cells therefore shaded into one another. Every cell in
 * `refs/water/lake-cartoon-cells.jpg` is a FLAT PLATE of its own tone with a
 * bright rim around it — a honeycomb, not a marbled field — and a flat
 * per-cell tone is exactly what a distance function cannot express.
 *
 * Baking it puts the cell index in a channel, so `B` is constant across a cell
 * and steps at the border. It is also four texture channels instead of a
 * two-point Worley search per octave per pixel, and the mip chain does the
 * minification filtering that hand-written `smoothstep` fades were
 * approximating.
 *
 * CHANNELS, all 0..1:
 *   R  ROUNDED border distance — a soft-min over the per-neighbour bisector
 *      distances, so cell corners and triple points come out bevelled.
 *   G  SHARP border distance — the hard min of the same set. 0 on a border.
 *   B  a flat per-cell tone. Constant within a cell, uncorrelated between.
 *   A  a second flat per-cell value, for per-cell phase.
 *
 * R AND G ARE THE SAME FIELD AT TWO ROUNDNESSES, and the material mixes between
 * them with `cellRound`. `F2 - F1` — what this used to store in G — is only an
 * approximation of the border distance, and its own literature describes the
 * result as "angular cobblestones": bisectors are straight and three of them
 * meet at a point, so every cell is a hard polygon. The accurate distance is the
 * minimum over neighbours of the distance to each BISECTOR, and taking that
 * minimum softly (a log-sum-exp) rounds precisely the corners where the
 * minimum switches from one neighbour to the next.
 *
 * TILEABLE, because it is sampled at world-locked UVs and must repeat without a
 * seam: sites are jittered on a toroidal grid and the distance search wraps, so
 * the field is continuous across the tile edge.
 *
 * `TILE_CELLS` is the repeat period in cells. It is the one number to raise if
 * the tiling ever becomes legible; the cost is memory, at
 * `RES^2 * 4` bytes. The domain warp in `cellsAt` and the two octaves at
 * different scales both act to break the period before it reads.
 */
/**
 * The repeat period in cells. 8, and MEASURED not to be legible: quadrupling it
 * to 16 left the render's strongest periodic autocorrelation peak where it was
 * (lag 395 excess 0.156 -> lag 364 excess 0.167 on a top-down frame), so that
 * periodicity is something else — the wave field, most likely — and not this
 * tile. The domain warp in `cellsAt` is not periodic with the tile, which is
 * what breaks the repeat.
 */
export const TILE_CELLS = 8
const RES = 1024

/** Deterministic — no `Math.random()` anywhere in generation. */
function hash2(ix: number, iy: number, salt: number): number {
  let h = ix * 374761393 + iy * 668265263 + salt * 2147483647
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

let cached: THREE.DataTexture | null = null

export function voronoiTexture(): THREE.DataTexture {
  if (cached) return cached

  const px = RES / TILE_CELLS // pixels per cell
  const data = new Uint8Array(RES * RES * 4)

  // Site positions and per-cell values, one per toroidal grid cell.
  //
  // JITTER NEAR THE MAXIMUM, because the reference's cells vary in area by two
  // or three to one and a lightly jittered grid gives cells of nearly equal
  // size — which reads as a regular hex net, or as stained-glass leading. It
  // stays just under 1.0 so a site cannot leave its own grid cell, which is
  // what bounds the distance search to the 3x3 neighbourhood below.
  const site: Float32Array = new Float32Array(TILE_CELLS * TILE_CELLS * 2)
  const tone: Float32Array = new Float32Array(TILE_CELLS * TILE_CELLS * 2)
  for (let gy = 0; gy < TILE_CELLS; gy++) {
    for (let gx = 0; gx < TILE_CELLS; gx++) {
      const i = gy * TILE_CELLS + gx
      site[i * 2] = gx + 0.5 + (hash2(gx, gy, 1) - 0.5) * 0.98
      site[i * 2 + 1] = gy + 0.5 + (hash2(gx, gy, 2) - 0.5) * 0.98
      tone[i * 2] = hash2(gx, gy, 3)
      tone[i * 2 + 1] = hash2(gx, gy, 4)
    }
  }

  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const cx = (x + 0.5) / px
      const cy = (y + 0.5) / px
      const gx0 = Math.floor(cx)
      const gy0 = Math.floor(cy)

      // Pass one: the nearest site. Its cell is the one this pixel belongs to,
      // and every bisector below is measured against it.
      let f1 = 1e9
      let best = 0
      let bsx = 0, bsy = 0
      const nx: number[] = []
      const ny: number[] = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // Wrap the LOOKUP but not the offset, so the distance is measured to
          // the site's unwrapped position. This is what makes the tile seamless.
          const gx = gx0 + dx
          const gy = gy0 + dy
          const wx = ((gx % TILE_CELLS) + TILE_CELLS) % TILE_CELLS
          const wy = ((gy % TILE_CELLS) + TILE_CELLS) % TILE_CELLS
          const i = wy * TILE_CELLS + wx
          const sx = site[i * 2]! + (gx - wx)
          const sy = site[i * 2 + 1]! + (gy - wy)
          nx.push(sx); ny.push(sy)
          const d = Math.hypot(cx - sx, cy - sy)
          if (d < f1) { f1 = d; best = i; bsx = sx; bsy = sy }
        }
      }

      // Pass two: distance to each bisector between the owning site and its
      // neighbours. `dot(p - midpoint, unit(s_j - s_i))` is the exact distance to
      // the cell wall those two sites share.
      //
      // A POLYNOMIAL SMOOTH MINIMUM, not a log-sum-exp one.
      //
      // `-ln(SUM exp(-K d)) / K` is the obvious smooth min and it is WRONG here,
      // by a fixed amount: it undershoots the true minimum by up to ln(n)/K, and
      // with eight neighbours at K = 11 that is 0.189 in cell units — larger than
      // `cellRim` itself. Every pixel's border distance came out at or below
      // zero, so the rim covered the whole surface as near-white: `cellBorder`
      // collapsed to 0.000-0.044, `deepVal` rose to 0.82 against the reference's
      // 0.74, and 57% of the sea scored as FOAM because the gate's foam test is
      // low saturation and high value. It read exactly as "opaque, washed out".
      //
      // The polynomial form undershoots by at most BEV/4 and only where two
      // distances are within BEV of each other, which is precisely the corners
      // and nowhere else. `BEV` is the bevel radius in cell units.
      const BEV = 0.16
      let hard = 1e9
      let soft = 1e9
      for (let j = 0; j < nx.length; j++) {
        const dxs = nx[j]! - bsx
        const dys = ny[j]! - bsy
        const len = Math.hypot(dxs, dys)
        if (len < 1e-6) continue
        // SIGN: positive INSIDE the owning cell. `p` sits on the owning site's
        // side of the bisector, so `dot(p - midpoint, s_j - s_i)` is negative
        // there and the midpoint-minus-p form is the one that reads as a
        // distance. Getting this backwards made the whole field negative —
        // measured mean -1.98 against the old field's +0.27, so 100% of pixels
        // fell inside `cellRim` and the rim covered the entire sea as near-white.
        const d = (((bsx + nx[j]!) * 0.5 - cx) * dxs
          + ((bsy + ny[j]!) * 0.5 - cy) * dys) / len
        if (d < hard) hard = d
        if (soft > 1e8) { soft = d; continue }
        const h = Math.max(BEV - Math.abs(soft - d), 0) / BEV
        soft = Math.min(soft, d) - h * h * BEV * 0.25
      }
      if (!Number.isFinite(hard)) hard = 0
      if (!Number.isFinite(soft)) soft = hard

      // Both stored at the F2 - F1 scale (twice the bisector distance) so the
      // authored `cellRim` keeps meaning the same thing across the mix.
      const o = (y * RES + x) * 4
      data[o] = Math.max(0, Math.min(255, Math.round(soft * 2 * 255)))
      data[o + 1] = Math.max(0, Math.min(255, Math.round(hard * 2 * 255)))
      data[o + 2] = Math.round(tone[best * 2]! * 255)
      data[o + 3] = Math.round(tone[best * 2 + 1]! * 255)
    }
  }

  const tex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  cached = tex
  return tex
}
