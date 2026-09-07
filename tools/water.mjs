// Water gate.
//
// Calibrated so both images in refs/water/ pass, per CLAUDE.md: "Each is
// calibrated so all six images in refs/ pass. If a gate fails your output, your
// output is wrong. Do not loosen a threshold to pass."
//
// FOUR METRICS, EACH WITH A FLOOR AND A CEILING. CLAUDE.md: "Every gate needs a
// floor AND a ceiling ... a one-sided metric is an invitation to optimise the
// proxy instead of the goal." The one-sided versions of these are all trivially
// gameable and it is worth naming how, because each was written one-sided first:
//
//   ladder   floor only -> paint a rainbow. Signed and range-bounded instead.
//   chroma   floor only -> acid cyan. Ceiling from the reference's own S0.77.
//   foam     floor only -> whiten the frame. A subject/control RATIO plus an
//            absolute ceiling on the subject: you cannot satisfy a ratio by
//            changing everything, which is the loophole every absolute
//            threshold in this repo has eventually leaked.
//   ripple   floor only -> per-pixel noise, which is exactly what round 1 of
//            this material shipped. Split into a COARSE floor and a FINE
//            ceiling so "there is structure" and "it is not tinfoil" are two
//            different tests.
//
// SUBJECT-VS-CONTROL WHEREVER POSSIBLE. The foam and wake metrics measure a
// named region against bare water in the same frame, so a change that lifts the
// whole image cannot move them.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-water'
fs.mkdirSync(TMP, { recursive: true })

function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

const rgbToHsv = (r, g, b) => {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
    if (h < 0) h += 360
  }
  return [h, mx > 0 ? d / mx : 0, mx]
}

const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/** Fractional box -> pixel box, so regions are resolution independent. */
const box = (png, f) => ({
  x0: Math.round(f[0] * png.width), y0: Math.round(f[1] * png.height),
  x1: Math.round(f[2] * png.width), y1: Math.round(f[3] * png.height),
})

function region(png, f) {
  const b = box(png, f)
  let r = 0, g = 0, bl = 0, n = 0
  const lum = []
  let foam = 0
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const o = (y * png.width + x) * 4
      const R = png.data[o], G = png.data[o + 1], B = png.data[o + 2]
      r += R; g += G; bl += B; n++
      lum.push(luma(R, G, B))
      const [, s, v] = rgbToHsv(R, G, B)
      // FOAM IS A COLOUR TEST, NOT A BRIGHTNESS TEST. Sunlit shallow water is
      // as bright as foam and nothing like as pale — the reference's foam ring
      // measures S0.08 against S0.15-0.21 for the shallow bands right beside it
      // — so the discriminator has to be saturation with brightness as a guard.
      //
      // S<0.10, NOT S<0.18, and the reference is what tightened it: at 0.18 the
      // shore-band box scored 0.349 foam and the OPEN-WATER control box beside
      // it scored 0.73, i.e. the test was counting the pale sandy shallows as
      // surf and the gate reported a foam ratio of 0.48 on the very picture it
      // is calibrated against. The reference's foam and its shallows are 0.07
      // apart in saturation and 0.35 apart in nothing else, so saturation is
      // the only axis that separates them and the threshold has to sit inside
      // that gap.
      if (s < 0.10 && v > 0.85) foam++
    }
  }
  const mean = [r / n, g / n, bl / n]
  const [h, s, v] = rgbToHsv(...mean)
  const mu = lum.reduce((a, c) => a + c, 0) / lum.length
  const sd = Math.sqrt(lum.reduce((a, c) => a + (c - mu) ** 2, 0) / lum.length)
  return {
    hue: h, sat: s, val: v, luma: mu, std: sd, foam: foam / n, n,
    hex: '#' + mean.map((c) => Math.round(c).toString(16).padStart(2, '0')).join(''),
  }
}

/**
 * Coarse and fine structure inside a box.
 *
 * `coarse` is the standard deviation after an 8 px box blur — real ripple, the
 * thing the reference has. `fine` is what a 3 px blur removes — PER-PIXEL noise,
 * the thing round 1 of this material had instead. Two numbers because one cannot
 * tell them apart: the tinfoil frame and the reference frame had nearly the same
 * total std.
 *
 * `fine` USED TO BE THE 8 px RESIDUAL, and that conflated two different faults.
 * Anything narrower than 8 px counted, which includes a legitimate hard-edged
 * cartoon rim: measured, the cell rims took `fine` to 0.031-0.055 while the
 * reference that governs those rims reads 0.048-0.063 itself and the
 * photographic reference reads 0.0069. A ceiling calibrated on the photographic
 * reference was therefore forbidding the cartoon reference's own line work.
 * Narrowing the cutoff to 3 px separates them properly: a 4 px rim survives a
 * 3 px blur and does not register, while single-pixel crawl still does.
 */
function structure(png, f) {
  const b = box(png, f)
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const src = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + b.y0) * png.width + (x + b.x0)) * 4
      src[y * w + x] = luma(png.data[o], png.data[o + 1], png.data[o + 2])
    }
  }
  // RADII SCALE WITH THE FRAME, and until they did this pair was comparing a
  // 1600 px capture against a 564 px reference with fixed 8 px and 3 px windows —
  // an error one-sided in the build's favour, because the build's content is
  // busy and the reference's is smooth. Measured: `water-vista`'s own gate box
  // reads fine 0.0169 at 1600 px and 0.0271 at 564 px. Same content, and at the
  // reference's resolution it FAILS the 0.020 ceiling it was passing.
  // `cells()` already did this; `structure()` claimed it in the header and did
  // not do it.
  const R = Math.max(2, Math.round(png.width * 0.005))
  const RF = Math.max(1, Math.round(png.width * 0.002))
  const blur = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += src[yy * w + xx]; n++
        }
      }
      blur[y * w + x] = sum / n
    }
  }
  const std = (a) => {
    const mu = a.reduce((s, c) => s + c, 0) / a.length
    return Math.sqrt(a.reduce((s, c) => s + (c - mu) ** 2, 0) / a.length)
  }
  const fineBlur = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0
      for (let dy = -RF; dy <= RF; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -RF; dx <= RF; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += src[yy * w + xx]; n++
        }
      }
      fineBlur[y * w + x] = sum / n
    }
  }
  const detail = new Float64Array(w * h)
  for (let i = 0; i < src.length; i++) detail[i] = src[i] - fineBlur[i]
  return { coarse: std(blur), fine: std(detail) }
}

/**
 * CELL AMPLITUDE — the cartoon register, and the metric this gate was missing.
 *
 * `p90 - p10` of luma after a blur of 1% of the FRAME width. Two properties
 * matter and neither is optional:
 *
 *   RESOLUTION-INDEPENDENT. The blur radius scales with the frame, so a 564 px
 *   reference and a 1600 px capture are asked the same question about the same
 *   world-scale feature.
 *
 *   JPEG-INSENSITIVE. This is what lets `lake-cartoon-cells.jpg` govern the
 *   register at last. That file was excluded from the `coarse`/`fine` pair
 *   because its 8x8 block noise reads as detail — and the consequence was that
 *   the ONE image the brief names as the target ("more cartoony like the
 *   graphic") had no structural test on it at all, so the build converged on the
 *   other reference and matched it to two decimal places while being nowhere
 *   near the cartoon one. A percentile spread after a wide blur throws the
 *   block noise away and keeps the cells: measured, the lake reads 0.124 and
 *   the photographic-register reference reads 0.036.
 *
 * `edge` is p99/p50 of the gradient magnitude — "flat masses meeting at hard
 * borders" (15.2 on the lake) against "soft gradients everywhere" (4.2).
 */
function cells(png, f) {
  const b = box(png, f)
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const src = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + b.y0) * png.width + (x + b.x0)) * 4
      src[y * w + x] = luma(png.data[o], png.data[o + 1], png.data[o + 2])
    }
  }
  const R = Math.max(1, Math.round(png.width * 0.005))
  const blur = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += src[yy * w + xx]; n++
        }
      }
      blur[y * w + x] = sum / n
    }
  }
  const pct = (arr, q) => {
    const a = [...arr].sort((p, r) => p - r)
    return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]
  }
  const grad = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = blur[y * w + x + 1] - blur[y * w + x - 1]
      const gy = blur[(y + 1) * w + x] - blur[(y - 1) * w + x]
      grad.push(Math.hypot(gx, gy))
    }
  }
  const g50 = pct(grad, 0.5), g99 = pct(grad, 0.99), g95 = pct(grad, 0.95)
  // PLATEAU FRACTION — the scale-free version of "flat masses meeting at hard
  // borders", and the reason `edge` below is now a diagnostic rather than a
  // gate.
  //
  // `edge` is p99/p50 of the gradient, and it turned out to measure PIXELS PER
  // CELL rather than border hardness: the same material, unchanged, scored 48.9
  // on `water-close` (big cells, huge flat interiors, tiny p50) and 4.6 on
  // `water-open` (small cells, borders everywhere, large p50), i.e. it failed in
  // both directions at once and no material could satisfy both. A metric that
  // two frames of one shader disagree about is measuring the camera.
  //
  // The share of pixels whose gradient is under 15% of the box's own p95 is
  // scale-free by construction — it is a ratio inside one image — and it says
  // the thing the reference is actually distinctive for: most of the area is
  // FLAT, and the variation is concentrated into a few per cent of it.
  const flatCut = g95 * 0.15
  let flat = 0
  for (const g of grad) if (g < flatCut) flat++

  // DETRENDED SPREAD. `p90 - p10` of the blurred luma is fed by the DEPTH RAMP
  // as much as by the cells, and on a frame whose box straddles a lot of depth
  // that is most of the score: measured, the lake reference loses 15% of its
  // spread to a 6%-of-width detrend (0.156 -> 0.133) and the build's close-water
  // frame lost 84% (0.081 -> 0.013). Same floor, honest input.
  const RD = Math.max(2, Math.round(png.width * 0.06))
  const trend = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0
      for (let dy = -RD; dy <= RD; dy += 2) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -RD; dx <= RD; dx += 2) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += src[yy * w + xx]; n++
        }
      }
      trend[y * w + x] = sum / n
    }
  }
  const flatField = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) flatField[i] = blur[i] - trend[i]

  // BORDER OCCUPANCY — the single metric that would have failed the previous
  // round, and the only one here that is unforgeable in BOTH directions.
  //
  // The fraction of the box where local luma variation over a 1%-of-width window
  // exceeds 0.030, measured on an image pre-blurred at 0.3%W. The pre-blur means
  // per-pixel crawl cannot supply it; the numerator being a variation means blur
  // cannot supply it either. Amplitude metrics have neither property: a smooth
  // gradient and a field of hard-edged masses can carry the same p90-p10.
  //
  // Reference: the cartoon lake reads 0.530 — half its water area is inside a
  // border — against 0.000 for the photographic reference's open sea. That gap
  // IS the register the brief is asking for.
  const win = Math.max(3, Math.round(png.width * 0.01))
  let border = 0, cells = 0
  for (let y = 0; y + win <= h; y += Math.max(1, win >> 1)) {
    for (let x = 0; x + win <= w; x += Math.max(1, win >> 1)) {
      let mu = 0, n = 0
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) { mu += blur[(y + j) * w + x + i]; n++ }
      }
      mu /= n
      let v = 0
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const d = blur[(y + j) * w + x + i] - mu
          v += d * d
        }
      }
      cells++
      if (Math.sqrt(v / n) > 0.030) border++
    }
  }

  return {
    spread: pct(flatField, 0.9) - pct(flatField, 0.1),
    border: cells > 0 ? border / cells : 0,
    plateau: flat / Math.max(1, grad.length),
    edge: g50 > 1e-6 ? g99 / g50 : 0,
  }
}

/**
 * LACINESS — is the foam a chain of shapes, or one painted slab?
 *
 * `runs` is the mean number of separate horizontal foam runs per scanline that
 * contains any foam; `maxRun` is the longest single run as a fraction of the box
 * width. The reference's ring chain crosses a scanline many times and never in
 * one long piece (13.6 runs, longest 0.39); a slab crosses once and fills it
 * (1.8 runs, longest 0.67).
 *
 * This is the pair that a `share`-and-`ratio` test cannot see. Measured, the
 * build passed `wakeShare 0.114 / wakeRatio 8597` while drawing a hard-edged
 * chalk line — the share was right, the SHAPE was not, and share is blind to
 * shape by construction.
 */
function laciness(png, f) {
  const b = box(png, f)
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const foam = (x, y) => {
    const o = (y * png.width + x) * 4
    const [, sa, v] = rgbToHsv(png.data[o], png.data[o + 1], png.data[o + 2])
    return sa < 0.10 && v > 0.85
  }
  let lines = 0, runs = 0, maxX = 0, maxY = 0
  for (let y = b.y0; y < b.y1; y++) {
    let inRun = false, thisLine = 0, run = 0
    for (let x = b.x0; x < b.x1; x++) {
      if (foam(x, y)) {
        run++
        if (!inRun) { thisLine++; inRun = true }
      } else {
        if (run > maxX) maxX = run
        run = 0
        inRun = false
      }
    }
    if (run > maxX) maxX = run
    if (thisLine > 0) { lines++; runs += thisLine }
  }
  // AND THE SAME SCAN DOWN THE COLUMNS, because the horizontal one alone
  // measures the CAMERA. A surf band is thin ACROSS the shore and long ALONG it,
  // so a camera looking down the beach puts a scanline along the band and reads a
  // long run out of a perfectly thin outline: `water-rocks` scored 0.399 against
  // a 0.26 ceiling on a band that is 16 px thick. A slab is long in BOTH axes and
  // an outline in neither, so the discriminating figure is the SMALLER of the two.
  for (let x = b.x0; x < b.x1; x++) {
    let run = 0
    for (let y = b.y0; y < b.y1; y++) {
      if (foam(x, y)) { run++ } else { if (run > maxY) maxY = run; run = 0 }
    }
    if (run > maxY) maxY = run
  }
  // STROKE WIDTH — `2 * area / perimeter`, the orientation-free measure of "is
  // this an outline or a slab", and the one that replaced `maxRun` as the gate.
  //
  // `maxRun` measures the SHORELINE'S ORIENTATION relative to the scan, not the
  // band's thickness, and the proof is that `water-rocks` reported 0.399 at
  // foamShore 15 m, 9 m AND 6.5 m — three band widths, one number, unchanged.
  // Scanning in both axes and taking the smaller does not fix it either: on a
  // shoreline that curves through both orientations, as that frame's does, both
  // axes catch a long run. A ribbon's area-to-perimeter ratio is its width no
  // matter which way it is pointing.
  //
  // Reference: the lake's shore outline is 0.55% of frame width, its wet-sand
  // lace 0.11%, its ring chain 0.35%. Ours measured 1.0-1.2%.
  let area = 0, perim = 0
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      if (!foam(x, y)) continue
      area++
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < b.x0 || ny < b.y0 || nx >= b.x1 || ny >= b.y1 || !foam(nx, ny)) {
          perim++
          break
        }
      }
    }
  }
  return {
    runs: lines > 0 ? runs / lines : 0,
    stroke: perim > 0 ? (2 * area / perim) / png.width : 0,
    // BOTH RUNS NORMALISED BY FRAME WIDTH, not each by its own box dimension.
    // Dividing the vertical run by box HEIGHT makes the answer depend on the
    // box's aspect ratio: `water-shore`'s shore box is 1040 x 162, so a 51 px
    // band measured 0.315 vertically and 0.217 horizontally and the "minimum"
    // picked the horizontal — reporting a 51 px band as a fifth of the frame.
    // Against one length the minimum is the band's THICKNESS wherever it is
    // thickest, which is the quantity intended.
    maxRun: Math.min(maxX, maxY) / png.width,
  }
}

/** Signed shortest hue difference b - a, degrees. */
const hueDelta = (a, b) => {
  let d = ((b - a) % 360 + 540) % 360 - 180
  return d
}

/**
 * The depth ladder: hue rotation and saturation fall from shallow to deep.
 *
 * SIGNED, and that is a lesson this repo already paid for once — see the
 * "Resolved: distance doesn't read as blue haze" note in CLAUDE.md, where an
 * unsigned hue metric "scored an INVERTED ladder as highly as a correct one".
 * Shallow-to-deep must rotate toward CYAN (increasing hue on the 57 -> 192
 * arc), so the sign is part of the test.
 */
function ladder(png, bands) {
  const rs = bands.map((b) => region(png, b))
  const total = hueDelta(rs[0].hue, rs[rs.length - 1].hue)
  let forward = 0
  for (let i = 1; i < rs.length; i++) {
    if (hueDelta(rs[i - 1].hue, rs[i].hue) > 0) forward++
  }
  return {
    rotation: total,
    monotone: forward / (rs.length - 1),
    satDrop: rs[0].sat - rs[rs.length - 1].sat,
    bands: rs,
  }
}

/**
 * FROTH vs HOOPS — enclosed holes in the foam mask, and how much of the mask's
 * own footprint the foam fills.
 *
 * The two numbers that separate `refs/water/shore-foam-wake.jpg`'s wake from a
 * chain of smooth rings, and neither was measurable before. The reference's wake
 * is a frothy MASS riddled with small pockets: 27 enclosed holes, the largest
 * 3.4% of frame width, and the foam fills 41% of the region it occupies. Ours
 * was 5 holes, the largest 16.1%W — those are the ring INTERIORS, not lace — and
 * 22% fill. Same topology, opposite texture.
 *
 * `fill` is foam area over foam-plus-enclosed-hole area, which is a cheap stand
 * -in for the critic's convex-hull measure and discriminates the same way: a
 * mass with pinholes scores high, thin rings round big voids score low. It needs
 * no hull, so it cannot be moved by where the box is placed.
 *
 * `holeMax` has a CEILING and `fill` a floor-and-ceiling: a solid slab scores
 * fill 1.0 with no holes at all, which is the other failure this pair has to
 * catch, and it hits the fill ceiling.
 */
function froth(png, f) {
  const b = box(png, f)
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const mask = new Uint8Array(w * h)
  let foamArea = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + b.y0) * png.width + (x + b.x0)) * 4
      const [, sa, v] = rgbToHsv(png.data[o], png.data[o + 1], png.data[o + 2])
      if (sa < 0.10 && v > 0.85) { mask[y * w + x] = 1; foamArea++ }
    }
  }
  // Flood the non-foam regions; any that never touches the box edge is enclosed.
  const seen = new Uint8Array(w * h)
  const stack = []
  let holes = 0, holeArea = 0, holeMax = 0
  for (let i = 0; i < w * h; i++) {
    if (mask[i] || seen[i]) continue
    stack.length = 0
    stack.push(i)
    seen[i] = 1
    let n = 0, open = false
    while (stack.length) {
      const j = stack.pop()
      const jx = j % w, jy = (j - jx) / w
      n++
      if (jx === 0 || jy === 0 || jx === w - 1 || jy === h - 1) open = true
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + dx, ny = jy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const k = ny * w + nx
        if (!mask[k] && !seen[k]) { seen[k] = 1; stack.push(k) }
      }
    }
    if (open) continue
    holes++
    holeArea += n
    // Equivalent diameter, as a fraction of frame width.
    const dia = 2 * Math.sqrt(n / Math.PI) / png.width
    if (dia > holeMax) holeMax = dia
  }
  // HULL FILL — foam area over the envelope the foam actually occupies, summed
  // per row as (max x - min x) of foam on that row.
  //
  // THIS REPLACED `fill` AS THE GATE because `fill` had the wrong denominator and
  // reported this build's failure with the wrong SIGN. `fill` divides by foam
  // plus ENCLOSED holes, so a chain with large OPEN gaps between its rings scores
  // high: `water-wake` read fill 0.819 against the reference's 0.562 — apparently
  // over-filled — while the envelope measure reads 0.512 against 0.720, i.e. the
  // wake is half-empty inside its own footprint. Tuning against `fill` would have
  // driven the build away from the reference while the number improved.
  //
  // `fill` is kept as a diagnostic: it is the one that catches a solid slab.
  // The envelope is the INTERSECTION of the per-row and per-column foam spans,
  // not the row spans alone. A row-span sum over-counts badly on a diagonal
  // chain — it reads 0.477 on the reference where the intersection reads 0.720 —
  // because a single row crossing a diagonal ribbon spans the whole ribbon's
  // horizontal extent while containing very little of it.
  const rowLo = new Int32Array(h).fill(-1)
  const rowHi = new Int32Array(h).fill(-1)
  const colLo = new Int32Array(w).fill(-1)
  const colHi = new Int32Array(w).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (rowLo[y] < 0) rowLo[y] = x
      rowHi[y] = x
      if (colLo[x] < 0) colLo[x] = y
      colHi[x] = y
    }
  }
  let hull = 0
  for (let y = 0; y < h; y++) {
    if (rowLo[y] < 0) continue
    for (let x = rowLo[y]; x <= rowHi[y]; x++) {
      if (colLo[x] >= 0 && y >= colLo[x] && y <= colHi[x]) hull++
    }
  }
  return {
    holes,
    holeMax,
    hull: hull > 0 ? foamArea / hull : 0,
    fill: foamArea > 0 ? foamArea / (foamArea + holeArea) : 0,
  }
}

/**
 * COMPACT FOAM RINGS — "is there anything standing in the water".
 *
 * Connected components of the foam mask, counting only those that are compact
 * (bounding-box aspect 0.5..2.0) and neither dust nor a slab. A collar round a
 * rock is compact; a surf band is a long thin ribbon; per-pixel speckle is tiny.
 *
 * This is the metric the previous round had no equivalent of, and its absence is
 * why a feature that shipped as working code went undelivered: `ScatterEntry.wade`
 * and the collar stamp were both correct and in the build, and a review measured
 * 0.0000% rock-like pixels across 2.53 million pixels of water in five captures.
 * The reference's shore box contains 8 such components; every build capture
 * contained none, and nothing said so.
 */
function solidFoam(png, f) {
  const b = box(png, f)
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + b.y0) * png.width + (x + b.x0)) * 4
      const [, sa, v] = rgbToHsv(png.data[o], png.data[o + 1], png.data[o + 2])
      mask[y * w + x] = sa < 0.10 && v > 0.85 ? 1 : 0
    }
  }
  const seen = new Uint8Array(w * h)
  const stack = []
  let compact = 0
  const areaLo = w * h * 0.00015
  const areaHi = w * h * 0.05
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue
    stack.length = 0
    stack.push(i)
    seen[i] = 1
    let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1
    while (stack.length) {
      const j = stack.pop()
      const jx = j % w, jy = (j - jx) / w
      n++
      if (jx < x0) x0 = jx
      if (jx > x1) x1 = jx
      if (jy < y0) y0 = jy
      if (jy > y1) y1 = jy
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + dx, ny = jy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const k = ny * w + nx
        if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k) }
      }
    }
    if (n < areaLo || n > areaHi) continue
    const aspect = (x1 - x0 + 1) / Math.max(1, y1 - y0 + 1)
    if (aspect >= 0.4 && aspect <= 2.5) compact++
  }
  return { compact }
}

// SCREEN-SPACE SIZE METRICS ARE CAMERA-DISTANCE DEPENDENT. This has bitten the
// gate three times — `shoreStroke`, `holeMax` and `laceStroke` are all "how many
// per cent of frame width is this feature", and the same world-space feature
// measures two to three times larger in a frame whose camera is two to three
// times closer. Measured examples, all one feature at one world size:
//
//   the 8 m surf band    11.5 px on water-vista, 12.9 on water-shore, 18.6 on
//                        water-rocks (0.72%, 0.80%, 1.16% of frame width)
//   a ring interior      108 px in water-wake's near-trail box against 54 px in
//                        water-wake-turn's mid-trail box
//
// THE RULE, applied from here on: a box for a size metric goes where the feature
// sits at a comparable PIXEL scale to the reference's, and a frame whose camera
// is far outside that range does not carry that metric. This is the same call as
// `structure`/`palette` skipping water frames — scoping a measurement to where it
// is calibrated — and it is not a licence to move a box until a number passes:
// the box has to be placed on the feature, and the reason recorded.
//
// ── the frames, and the regions in each ─────────────────────────────────────
//
// Boxes are FRACTIONS of the frame so they survive a resolution change, and
// every one of them was placed by looking at the picture. CLAUDE.md: "Check
// where a measurement box actually lands. The two boxes offered as 'facets 70
// deg apart at identical luma' were on the same face."
//
// `ladder` runs shallow -> deep, so band 0 is the one nearest the sand.
const FRAMES = {
  // ── the references ────────────────────────────────────────────────────────
  'refs/water/shore-foam-wake.jpg': {
    // Top-down. Dry sand at the bottom, open sea at the top. Band centres were
    // read off an 8x6 grid probe of the image rather than guessed: the rows
    // measure H71/S0.17, H92/S0.16, H135/S0.16, H177/S0.44, H190/S0.75,
    // H191/S0.74, which is +120 degrees of rotation, 5 of 5 steps forward, and
    // saturation RISING 0.17 -> 0.74 into the deep.
    ladder: [
      [0.30, 0.84, 0.70, 0.88], [0.30, 0.68, 0.70, 0.72],
      [0.30, 0.51, 0.70, 0.55], [0.30, 0.34, 0.70, 0.38],
      [0.30, 0.17, 0.70, 0.21], [0.30, 0.01, 0.70, 0.05],
    ],
    deep: [0.30, 0.02, 0.70, 0.12],
    // NO SHORE-FOAM BOX ON THIS REFERENCE, and it is worth being exact about
    // why rather than moving the threshold until something passed. This
    // picture's shore edge is WET SAND LACE, not surf: the grid probe reads
    // H47-96 at S0.15-0.19 across both bottom rows and scores 0.00 on the foam
    // test at any sane threshold. Its bright white is the ring chain and the
    // ring around the rock, which is the WAKE feature. So this frame calibrates
    // the wake, the ladder and the deep colour; `lake-cartoon-cells.jpg` — whose
    // shoreline genuinely is outlined in white — calibrates the shore band.
    //
    // The chain of foam rings, against bare water two rows up.
    wake: [0.62, 0.49, 0.94, 0.60],
    wakeControl: [0.62, 0.30, 0.94, 0.41],
    ripple: [0.30, 0.12, 0.70, 0.30],
    // NO `cells` BOX. This reference is the LOW end of the register — its open
    // sea measures cellSpread 0.030 and cellBorder 0.000 — and the brief picks
    // the other end ("more cartoony like the graphic"). Bracketing the cell
    // metrics between the two would put their floors under this image and the
    // metric would then pass a smooth gradient, which is the exact thing it
    // exists to fail. So the cell register is calibrated on the LAKE alone, and
    // this image governs colour, the ladder and the wake.
    // The ring chain, as a SHAPE. This is the box that calibrates laciness.
    lace: [0.62, 0.48, 0.95, 0.63],
  },
  'refs/water/lake-cartoon-cells.jpg': {
    // A pond, not a coast: no usable depth ladder and no wake. It governs the
    // DEEP COLOUR and — because every shoreline and every rock in it is drawn
    // with a white outline — the SHORE FOAM band.
    //
    // NO `ripple` BOX ON PURPOSE, and this is a limit of the reference rather
    // than a convenience. The file is a 37 KB, 564 px JPEG: measured, its
    // fine-detail figure is 0.0595 against 0.0069 for the other reference, and
    // that difference is compression and resolution, not brushwork. A ceiling
    // on per-pixel noise cannot be calibrated on an image whose per-pixel noise
    // is mostly the encoder's.
    deep: [0.36, 0.28, 0.56, 0.42],
    foam: [0.06, 0.58, 0.32, 0.80],
    foamControl: [0.30, 0.28, 0.62, 0.42],
    solidFoam: [0.06, 0.20, 0.94, 0.80],
    // The polygonal light cells over open water — the cartoon register itself.
    cells: [0.30, 0.20, 0.70, 0.55],
    // And its shoreline, which is an OUTLINE that breaks into lace.
    shoreLace: [0.06, 0.58, 0.32, 0.80],
  },

  // ── the build ─────────────────────────────────────────────────────────────
  //
  // Boxes here were placed off a 0.02-step COLUMN PROBE of each frame, not off
  // the 8x6 grid the references were placed with, because our shoreline runs
  // diagonally across the vista and a full-width band straddles sand, surf and
  // shallows at once. The column at x 0.60-0.78 of `water-vista` reads
  // H50/S0.43 sand -> H137 -> H167 -> H191 -> H194 -> H201/S0.62, which is the
  // ladder the band centres below sample.
  'water-vista': {
    ladder: [
      [0.60, 0.750, 0.78, 0.770], [0.60, 0.635, 0.78, 0.655],
      [0.60, 0.575, 0.78, 0.595], [0.60, 0.475, 0.78, 0.495],
      [0.60, 0.310, 0.78, 0.330], [0.60, 0.210, 0.78, 0.230],
    ],
    deep: [0.20, 0.28, 0.85, 0.42],
    // A GENEROUS box, containing the surf band AND the sand below it AND the
    // shallows above it. A box cropped to the band alone would read 0.5 and
    // measure how well the box was placed rather than how the water looks.
    foam: [0.20, 0.60, 0.85, 0.78],
    foamControl: [0.20, 0.28, 0.85, 0.42],
    // Mid-field water, not the far horizon: the ripple network fades with
    // camera distance on purpose (see `nearFade` in src/water/water.ts), so a
    // box at 400 m is measuring the fade, not the network.
    // The ripple and cell boxes sit in a band of near-CONSTANT depth, which is
    // not a detail. Placed across the shallow-to-deep transition they measure
    // the ladder's own step as if it were cell contrast — measured, the wider
    // box read cellSpread 0.221 and coarse 0.0897 where the constant-depth band
    // reads well inside both ranges, and the difference was entirely the ramp.
    ripple: [0.20, 0.30, 0.80, 0.38],
    shoreLace: [0.20, 0.58, 0.85, 0.80],
  },
  'water-shore': {
    shoreLace: [0.05, 0.42, 0.70, 0.60],
    foam: [0.05, 0.42, 0.70, 0.60],
    foamControl: [0.10, 0.28, 0.60, 0.38],
    deep: [0.10, 0.29, 0.60, 0.38],
    ripple: [0.15, 0.29, 0.80, 0.36],
  },
  // The waterline along the shore, with rocks standing in it. `solidFoam` is
  // gated here and nowhere else: this is the frame the feature exists in.
  // `shoreStroke` IS NOT GATED HERE, and the reason is a measurement rather
  // than a convenience.
  //
  // The metric is `2 * area / perimeter` normalised by frame WIDTH, so for a
  // fixed world-space band it scales with how close the camera is. Measured, the
  // same 8 m surf band reads 11.5 px on `water-vista`, 12.9 px on `water-shore`
  // and 18.6 px here — 0.72%, 0.80% and 1.16% of frame width — because this
  // camera stands 8 m above the waterline and the other two are two to four
  // times further from the band they are looking at. The reference's camera is at
  // the far end of that range (0.63%).
  //
  // So the stroke is gated on the two frames whose cameras sit at comparable
  // range to the reference's, and this frame — which exists to judge foam
  // COLLARS — keeps `solidRings` and the run count. Scoping a metric to where it
  // is calibrated, the same call as `structure`/`palette` skipping water frames.
  // The honest alternative would be a world-metres normalisation, and nothing in
  // a PNG gives the gate a world scale.
  'water-rocks': {
    solidFoam: [0.02, 0.10, 0.62, 0.62],
  },
  'water-open': {
    deep: [0.20, 0.50, 0.80, 0.62],
    ripple: [0.20, 0.50, 0.80, 0.70],
    cells: [0.20, 0.50, 0.80, 0.70],
  },
  // THE FRAME THAT JUDGES THE CARTOON REGISTER, and it needs its own camera.
  //
  // `cells` measures the amplitude and edge hardness of the light cells, and a
  // wide landscape shot cannot answer that question: on `water-vista`'s far
  // band the same water reads cellSpread 0.060 against 0.096 in `water-open`,
  // and the whole difference is perspective compression plus the 8 px blur the
  // metric uses. Measuring cell CONTRAST in a band where a cell is 15 px tall
  // measures the compression. So the cell boxes live on the two frames where
  // water is large on screen at roughly constant depth, and `water-vista` keeps
  // the ladder, the surf and the deep colour, which are what it is for.
  'water-close': {
    deep: [0.20, 0.30, 0.80, 0.42],
    cells: [0.10, 0.45, 0.90, 0.90],
    ripple: [0.10, 0.45, 0.90, 0.90],
  },
  // LIFTED 16 m, looking down over the car — the angle the reference's ring
  // chain is drawn from, and the only one a flat pattern's SHAPE can be
  // measured at. See the note on `camlift` in src/vehicle/camera.ts.
  'water-wake': {
    wake: [0.05, 0.78, 0.35, 0.98],
    wakeControl: [0.55, 0.55, 0.90, 0.75],
    // MID-TRAIL, not the near corner. The trail runs from the car to the bottom
    // -left, so the old box sat where it is closest to the camera and the rings
    // are largest on screen — its biggest void measured 108 px against 54 px in
    // the same feature further up the same trail. This box puts the chain at a
    // pixel scale comparable to `water-wake-turn`'s and to the reference's.
    lace: [0.10, 0.64, 0.42, 0.86],
  },
  // The same run from the gameplay camera. Share and ratio only; laciness is
  // not measurable at a grazing angle.
  'water-wake-low': {
    wake: [0.03, 0.55, 0.32, 0.70],
    wakeControl: [0.55, 0.55, 0.90, 0.70],
    ripple: [0.55, 0.50, 0.85, 0.66],
  },
  // Lifted too, for the same reason. Cornering is where the scrub term widens
  // the spray and the pulses fan out along the arc, and none of that is legible
  // from astern.
  'water-wake-turn': {
    wake: [0.00, 0.48, 0.30, 0.80],
    wakeControl: [0.55, 0.55, 0.95, 0.90],
    lace: [0.00, 0.46, 0.32, 0.82],
  },
}

// ── thresholds ─────────────────────────────────────────────────────────────
// Every number below is bracketed by a reference measurement, quoted.
const LIMITS = {
  // refs/water/shore-foam-wake.jpg measures +135 deg shallow -> deep.
  rotation: [45, 205],
  // 5 of 5 forward in the reference. One reversal is a wobble, two is a ladder
  // that does not run.
  monotone: [0.65, 1.01],
  // Reference: S 0.17 shallow -> 0.77 deep, i.e. a RISE, so the drop is
  // negative. Bracketed both ways: a ladder that desaturates into the deep is
  // as wrong as one that does not rotate.
  satDrop: [-0.85, -0.10],
  // Reference deep water: S0.74 (shore-foam-wake) and S0.60 (lake). The ceiling
  // is what stops this becoming acid cyan and it is NOT slack: measured, the
  // first pass at the palette arrived at S0.90 in open water — the per-channel
  // filmic tonemap and the grade push chroma up by about 0.05-0.20 on the way
  // to the screen, so an authored stop that already sits at the reference's
  // saturation overshoots it. The floor on value is what stops the fresnel
  // darkening that neither reference has any of.
  // BRACKETS BOTH REFERENCES, which the previous [0.40, 0.86] did not: the lake
  // measures 0.598 and the shore 0.741, so a ceiling of 0.86 sat 0.26 above the
  // image the brief names for register and let this build sit at 0.798-0.826 —
  // measurably more saturated than either reference at both the cell interior
  // (S0.82 against the lake's 0.57) and the rim (0.61 against 0.42) — while the
  // gate said ok. Same slack-ceiling failure as `cellBorder`'s old band, which
  // passed a bright green lily-pad mat.
  deepSat: [0.52, 0.80],
  deepVal: [0.58, 0.94],
  // Reference shore lace: 0.28 of the band is foam against ~0 in the mid-water
  // control. Ours will not reach the reference's ratio — its foam is opaque
  // paint and its control is literally zero — so the RATIO carries the floor
  // and `foamShare` carries the ceiling.
  //
  // THE RATIO HAS NO UPPER BOUND, and that is not a one-sided metric: a ratio
  // whose control is zero is unbounded by construction, and the two-sidedness
  // of this dimension lives in `foamShare`, which is the more meaningful
  // ceiling anyway — "the surf band must not be a solid white slab" is a
  // statement about the band, not about its contrast with open water.
  foamRatio: [3.0, Infinity],
  // Reference (lake-cartoon-cells.jpg) shore band: 0.09 of it is foam against
  // 0.00 in the deep-water control.
  // CEILING 0.40, DOWN FROM 0.72, and this one is justified in hindsight: while
  // a sign error in the Voronoi bake had the rim covering the whole sea as
  // near-white, `foamShare` measured 0.606 and the gate said nothing, because
  // 0.72 sits thirteen times above the lake reference's 0.056. References span
  // 0.056 (lake) to 0.322 (the shore reference's wake box) and this build runs
  // to 0.244, so 0.40 clears everything real and catches a flood.
  foamShare: [0.04, 0.40],
  wakeRatio: [2.5, Infinity],
  // Reference ring chain: 0.32 against 0.00.
  wakeShare: [0.03, 0.80],
  // COARSE is now bracketed by BOTH references, and that is a re-calibration
  // rather than a loosening. The ceiling was 0.048, set from
  // shore-foam-wake.jpg's 0.0182 alone, because lake-cartoon-cells.jpg had been
  // excluded from this metric over its JPEG noise. Measured, the lake reads
  // coarse 0.0346 on a clean box and 0.0762 on a wide one — the exclusion put
  // the ceiling BELOW a reference, which by this file's own rule means the gate
  // was wrong. `fine` keeps the narrow ceiling, because the lake's fine figure
  // (0.048-0.063) genuinely is mostly the encoder and cannot calibrate anything.
  // The sharp version of "is there structure, and is it the right structure"
  // now lives in `cellSpread`/`cellEdge`, which are blur-percentile measures and
  // therefore immune to the block noise that forced the exclusion.
  // 0.075. The Voronoi sign error produced `coarse` 0.0857 and only just tripped
  // this; references are 0.0173 and 0.0378 and this build runs to 0.0658.
  coarse: [0.008, 0.075],
  // `fine` IS BRACKETED BY BOTH REFERENCES, and the ceiling being 0.020 was the
  // same mis-calibration-by-exclusion that `coarse` had — with one difference:
  // this one cost four rounds of work before it was caught.
  //
  // Measured with the current resolution-proportional radii:
  //
  //   shore-foam-wake.jpg  open sea            0.0049
  //   lake-cartoon-cells.jpg  open water        0.0259
  //   lake-cartoon-cells.jpg  clean patch       0.0211
  //   ours, water-open                          0.0248
  //
  // The cartoon reference — the image the brief names as the target register —
  // FAILS a 0.020 ceiling on its own texture, and our open water sits within
  // 0.001 of it. So four consecutive anti-aliasing fixes (a screen-space fade for
  // the ridge octaves, one for each lace noise, an earlier fade for the flat
  // masses) were chasing a number that a reference cannot meet, and each was
  // correctly measured to change nothing because there was nothing there to fix.
  //
  // WHAT THIS METRIC CAN NO LONGER DO is tell cartoon texture apart from
  // aliasing: at a 0.4%-of-width window both look the same. So the ceiling is a
  // bound on total short-scale energy, not a crawl detector, and it must not be
  // used to justify removing texture.
  //
  // A REVIEW PROPOSED TIGHTENING IT by subtracting a per-image flat-control
  // `fine` in quadrature — a box on a region with no intended detail — to get a
  // content-only figure. It was tried and it does not survive these two images:
  //
  //   lake, open water (content + noise)   0.0259
  //   lake, flat painted rock face          0.0243   -> content-only 0.0089
  //   lake, flat painted grass              0.0134   -> content-only 0.0222
  //   shore, open sea (content + noise)     0.0049
  //   shore, dry beach                      0.0117   -> NEGATIVE
  //
  // Two controls inside one image disagree by a factor of two and give
  // content-only figures 2.5x apart, and the other reference's flattest available
  // region is NOISIER than its content region, which makes the subtraction
  // impossible rather than merely uncertain. A painted image has no region
  // guaranteed free of intended detail, so there is no control to calibrate
  // against.
  //
  // THE TEST THAT WOULD WORK is a two-resolution comparison of the same frame:
  // render at 800 px and compare against the 1600 px render downsampled to 800.
  // Genuine aliasing shows up as extra high-frequency energy in the low-res
  // render; real texture does not. `tools/shots.mjs` already takes SHOT_W/SHOT_H,
  // so the harness can do it — it is a new tool, not a threshold.
  //
  // The AA work was not wasted: mipping the shading normal toward vertical is
  // correct on its own terms (a `pow(dot(n, half), 320)` specular on a 7.3 m sine
  // sampled at metres per pixel is an aliasing amplifier however it measures),
  // and keying every fade to the derivative of `positionWorld` rather than of a
  // noise is a real fix — a finite difference over a 2x2 quad under-reports the
  // gradient of an already-aliased signal, so those fades could never engage.
  // Ceiling ON the cartoon reference's own texture (0.0259) rather than above it
  // — see the long `fine` note for why that image sets the ceiling and why this
  // metric cannot tell cartoon texture from aliasing.
  fine: [0.0003, 0.026],
  // THE CARTOON REGISTER. lake-cartoon-cells.jpg reads spread 0.124 / edge 15.2
  // over its open water; shore-foam-wake.jpg reads 0.036 / 4.2 over its. Those
  // two are a whole register apart and the brief picks a side — "I want more
  // cartoony like the graphic" — so the floor is set from the LAKE and the
  // ceiling above it, rather than bracketing both. A build that satisfies only
  // the photographic reference is the failure this metric exists to name.
  // BRACKETED ON THE LAKE REFERENCE, both sides, and the previous band was a
  // 2.4x over-grant on the floor and a 2.9x one on the ceiling.
  //
  // The old excuse for the low floor — "our water also has to work at a gameplay
  // camera on frames the reference never has to draw" — became obsolete the
  // moment `CELL_PX` existed, because the whole point of the scale-adaptive field
  // is that every camera presents cells at the reference's pixel scale. And the
  // slack ceiling let a genuinely bad picture through: at cellBorder 0.390
  // against the reference's 0.157 the sea was a bright green lily-pad mat and the
  // gate said `water ok`.
  //
  // Lake reference: cellSpread 0.133 (detrended), cellBorder 0.157.
  cellSpread: [0.085, 0.19],
  cellBorder: [0.090, 0.26],
  // `cellEdge` and `cellPlateau` are printed as diagnostics and NOT gated.
  // `cellEdge` = p99/p50 of the gradient, and its denominator collapses under
  // blur, so blurring the frame RAISES the score: the same material scored 48.9
  // on a smooth close-water frame and 4.6 on a correct open-water one, failing
  // in both directions at once. A metric two frames of one shader disagree
  // about is measuring the camera.
  // TWO CALIBRATIONS, because a wake and a shoreline are different shapes and
  // the first version of this metric conflated them — the lake reference's own
  // shoreline scored 1.95 against a 2.6 floor set from the ring chain, i.e. the
  // gate failed a reference, which per this file's own rule means the gate was
  // wrong and not the reference.
  //
  // WAKE. Reference ring chain: 13.96 runs per scanline, longest run 0.366 of
  // the box. The floor is well under the chain's figure — a car at 35 m/s
  // churns a denser thing than a boat painted at walking pace — but a slab
  // measures 2.08 with a 0.758 longest run, so `maxRun` is what catches it.
  laceRuns: [2.6, 40],
  // Reference ring chain stroke 0.47% of frame width, measured by this same
  // code. The ceiling was 0.014 — three times the reference — which is why a
  // stroke that had crept back to 0.0097 passed unremarked after the interior
  // froth thickened it. `laceMaxRun` is a diagnostic and no longer gated.
  laceStroke: [0.0012, 0.0085],
  // HULL FILL IS A DIAGNOSTIC, NOT A GATE, because I could not reproduce the
  // number it was meant to enforce. A review measured the reference's wake at
  // 0.720 hull fill and this build at 0.512 — 1.4x emptier inside its own
  // footprint — and my instrument disagrees under two different envelope
  // definitions: a row-span sum gives ref 0.477 / ours 0.550, and row-span
  // intersect column-span gives ref 0.507 / ours 0.550. Both say ours is at or
  // above the reference. The likely difference is the foam mask — the review used
  // S<0.20 V>0.80 against this file's S<0.10 V>0.85 — which moves numerator and
  // denominator together.
  //
  // CLAUDE.md: "Reproduce the critic's number with your own instrument before
  // acting on it." I cannot, so it gates nothing and the recommendation resting
  // on it is not acted on. What IS reproducible from the same review is the
  // STROKE above, which this code confirms to two decimal places.
  //
  // ENCLOSED-HOLE COUNT IS ALSO A DIAGNOSTIC ONLY, and this one is a semantics
  // failure rather than a calibration one. It counts holes the foam CLOSES
  // around, and a heavily perforated mass has pockets that are OPEN to the
  // outside: measured, raising `wakeLace` 0.95 -> 1.3 took the count from 7 to 3
  // while every other number moved toward the reference — stroke 0.0088 -> 0.0065
  // against the reference's 0.0047, hull fill 0.681 -> 0.594 against 0.507. The
  // picture got more perforated and the metric said less.
  //
  // `laceStroke` already measures perforation and does it for both topologies:
  // `2 * area / perimeter` IS the inverse of perimeter density, so a mass punched
  // full of pockets scores thin whether the pockets are enclosed or open. Two
  // metrics for one property, one of which only works on the reference's
  // topology, is worse than one that works on both.
  // Reference: largest enclosed hole 3.4% of frame width.
  // CEILING ONLY, deliberately. A floor here was tried and removed: hole size in
  // FRAME WIDTH depends on the ring radius on screen, so a floor taken from the
  // reference's large rings condemns any frame whose rings are legitimately
  // smaller. `fill` is the scale-free instrument for the same failure — it is a
  // ratio inside the wake's own footprint — and it carries the floor instead.
  holeMax: [0.0, 0.055],
  // THE SLAB GATE, promoted from diagnostic. Foam area over foam-plus-enclosed
  // holes: 1.0 is a solid paint spill, the reference's open ring chain is 0.562.
  // Promoted because thickening the stroke and filling the ring interiors both
  // scored green on every other wake metric while the wake became a slab —
  // each of those metrics is satisfied by MORE foam, so none of them could see
  // it. The note below explains why `fill` is wrong as the PRIMARY wake measure
  // (it reads an open chain as over-full); `hull` remains that. This is the
  // second half of the pair, and it only has to catch the solid case.
  fill: [0.38, 0.78],
  // The swash pair. Floors say the wash moves; ceilings say only the wash moves.
  // Floor: the wash moves. Ceiling: it is a wash, not a tide swallowing the
  // beach. `swashSand` is a CEILING only — the dry sand well above the
  // waterline must stay dry.
  // Floor sits between the measured swash-off baseline (0.0191) and the shipped
  // state (0.0455), which is what makes this a gate rather than a reassurance:
  // with the feature disabled it must FAIL, and it does. Ceiling because this is
  // a wash, not a tide swallowing the beach.
  swashRange: [0.026, 0.075],
  // Bob ripples. Floor on reach: they must extend past the wake (measured 0.047
  // of frame width with the feature OFF, 0.094 with it on). Floor on alt: rings
  // have gaps, a merged disc does not.
  rippleReach: [0.062, 0.17],
  rippleAlt: [2, 40],
  swashSand: [0.0, 0.010],
  // SHORE. Reference (lake) shoreline: 1.95 runs, longest run 0.082. A
  // shoreline is an OUTLINE, so the discriminating number is how LONG an
  // unbroken piece of it is, not how many pieces cross a line: ours measured
  // 0.489, i.e. half the box width in one solid stroke of white.
  // Compact foam rings — collars round things standing in the water. The lake
  // reference's shore box carries 8; the CEILING is what stops the metric being
  // satisfied by breaking the surf band into a field of blobs.
  solidRings: [1, 40],
  shoreRuns: [1.4, 12],
  // Reference shore outline stroke 0.55% of frame width, wet-sand lace 0.11%.
  shoreStroke: [0.0008, 0.010],
  // AND THE LONGEST UNBROKEN PIECE IS GATED AGAIN, on the two-axis version.
  //
  // The single-axis `maxRun` was demoted because it measured the shoreline's
  // ORIENTATION relative to the scan — it read 0.399 at three different band
  // widths. The two-axis minimum does not have that fault: an outline is thin in
  // at least one axis whatever way it points, and a slab is thick in both. It was
  // left printing as a diagnostic after the replacement and a review pointed out
  // that it is exactly the number separating lace from a paint spill: reference
  // 0.082, ours 0.226.
  shoreMaxRun: [0.008, 0.055],
}

const inRange = (v, [lo, hi]) => v >= lo && v <= hi
const fmt = (v, d = 3) => (v >= 0 ? ' ' : '') + v.toFixed(d)

export function analyse(file, spec) {
  const png = loadPng(file)
  const out = { file: path.basename(file), checks: [] }
  const check = (name, value, range, digits = 3) => {
    out.checks.push({ name, value, range, ok: inRange(value, range), digits })
  }

  if (spec.ladder) {
    const l = ladder(png, spec.ladder)
    out.ladder = l
    check('rotation', l.rotation, LIMITS.rotation, 1)
    check('monotone', l.monotone, LIMITS.monotone, 2)
    check('satDrop', l.satDrop, LIMITS.satDrop, 3)
  }
  if (spec.deep) {
    const d = region(png, spec.deep)
    out.deep = d
    check('deepSat', d.sat, LIMITS.deepSat)
    check('deepVal', d.val, LIMITS.deepVal)
  }
  if (spec.foam) {
    const s = region(png, spec.foam)
    const c = region(png, spec.foamControl)
    out.foamPair = [s.foam, c.foam]
    check('foamShare', s.foam, LIMITS.foamShare)
    check('foamRatio', s.foam / Math.max(c.foam, 1 / c.n), LIMITS.foamRatio, 2)
  }
  if (spec.wake) {
    const s = region(png, spec.wake)
    const c = region(png, spec.wakeControl)
    out.wakePair = [s.foam, c.foam]
    check('wakeShare', s.foam, LIMITS.wakeShare)
    check('wakeRatio', s.foam / Math.max(c.foam, 1 / c.n), LIMITS.wakeRatio, 2)
  }
  if (spec.ripple) {
    const st = structure(png, spec.ripple)
    out.ripple = st
    check('coarse', st.coarse, LIMITS.coarse, 4)
    check('fine', st.fine, LIMITS.fine, 4)
  }
  if (spec.cells) {
    const c = cells(png, spec.cells)
    out.cells = c
    check('cellSpread', c.spread, LIMITS.cellSpread)
    check('cellBorder', c.border, LIMITS.cellBorder)
  }
  if (spec.solidFoam) {
    const sf = solidFoam(png, spec.solidFoam)
    out.solidFoam = sf
    check('solidRings', sf.compact, LIMITS.solidRings, 0)
  }
  if (spec.lace) {
    const fr = froth(png, spec.lace)
    out.froth = fr

    check('holeMax', fr.holeMax, LIMITS.holeMax, 4)
    check('fill', fr.fill, LIMITS.fill, 3)
    const l = laciness(png, spec.lace)
    out.lace = l
    check('laceRuns', l.runs, LIMITS.laceRuns, 2)
    check('laceStroke', l.stroke, LIMITS.laceStroke, 4)
  }
  if (spec.shoreLace) {
    const l = laciness(png, spec.shoreLace)
    out.shoreLace = l
    check('shoreRuns', l.runs, LIMITS.shoreRuns, 2)
    check('shoreStroke', l.stroke, LIMITS.shoreStroke, 4)
    check('shoreMaxRun', l.maxRun, LIMITS.shoreMaxRun)
  }
  out.ok = out.checks.every((c) => c.ok)
  return out
}


/**
 * THE SWASH SERIES — does the wash actually move UP THE BEACH?
 *
 * Every other metric in this file is a resemblance test against a still image.
 * This one cannot be: `refs/water/` are photographs of one instant and a static
 * surf line photographs exactly like a moving one. So this is a REGRESSION
 * gate, calibrated against the measured swash-off state rather than against
 * refs/ — the one metric here that must not claim reference calibration.
 *
 * IT MEASURES WET COVERAGE OVER A CYCLE, and the two discarded designs are why.
 *
 *   1. Mean absolute luma difference over a band of shore, two frames half a
 *      cycle apart: 0.0328 with the swash running, 0.0300 with `swashAmp` at
 *      ZERO. The ordinary wave field moves the shallow colour bands and the surf
 *      lace through that band whatever the swash does.
 *   2. Wet coverage, same two frames: 0.0150 against 0.0120 off. Better, still
 *      not a gate — this shelf is flat enough that 0.32 m of ordinary wave
 *      sweeps the waterline about 80 m by itself.
 *
 * Six frames spanning one swash cycle separate the two. The swash is a single
 * coherent rise and fall over 13 s; the wave components are seconds long, so
 * across six samples they add scatter while the swash adds a sweep. The RANGE
 * over the series therefore grows with the swash and not with the waves.
 *
 * Wet is `blue > red` (any water) or near-white (foam), below the horizon; dry
 * sand is warm and fails both. The far dry sand is a control: it must not change,
 * or the sea is heaving rather than washing.
 *
 * MEASURED, on a correct build of each: range 0.0455 at `swashAmp` 0.90 against
 * 0.0191 with it at zero — a 2.4x margin. Coverage over the series is
 * 0.1333 0.1566 0.1788 0.1751 0.1520 0.1338, one clean rise and fall.
 *
 * AND CHECK THE BUILD BEFORE BELIEVING EITHER NUMBER. The first on/off pair came
 * out byte-identical because the "on" capture skipped `npm run build` and both
 * runs rendered the same swash-off bundle. That reads exactly like a dead
 * feature.
 */
function swashSeries(files) {
  const imgs = files.map(loadPng)
  const w = imgs[0].width, h = imgs[0].height
  if (imgs.some((p) => p.width !== w || p.height !== h)) return null
  const wet = (p, x, y) => {
    const o = (y * p.width + x) * 4
    const r = p.data[o], g = p.data[o + 1], bl = p.data[o + 2]
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl)
    const sat = mx ? (mx - mn) / mx : 0
    return (bl > r + 6) || (sat < 0.10 && mx > 218)
  }
  const cov = imgs.map((p) => {
    let c = 0, n = 0
    for (let y = Math.round(p.height * 0.42); y < p.height; y++) {
      for (let x = 0; x < p.width; x++) { n++; if (wet(p, x, y)) c++ }
    }
    return n ? c / n : 0
  })
  const lum = (p, x, y) => {
    const o = (y * p.width + x) * 4
    return (0.2126 * p.data[o] + 0.7152 * p.data[o + 1] + 0.0722 * p.data[o + 2]) / 255
  }
  // The dry-sand control, as the largest deviation of any frame from the first.
  let sand = 0
  const Y0 = Math.round(0.82 * h)
  for (let i = 1; i < imgs.length; i++) {
    let d = 0, n = 0
    for (let y = Y0; y < h; y++) {
      for (let x = 0; x < Math.round(w * 0.55); x++) {
        d += Math.abs(lum(imgs[0], x, y) - lum(imgs[i], x, y)); n++
      }
    }
    if (n && d / n > sand) sand = d / n
  }
  return { cov, range: Math.max(...cov) - Math.min(...cov), sand }
}

/**
 * `--limits` — print every bracket beside the reference values it was
 * calibrated on, worst slack first.
 *
 * THIS EXISTS BECAUSE "the references pass" IS NOT ENOUGH. A ceiling can sit
 * many multiples above the image it was set from and still let every reference
 * through, and twice in this file that slack hid a real fault: `cellBorder`'s
 * old band passed a bright green lily-pad mat, and `deepSat`'s [0.40, 0.86]
 * passed a sea measurably more saturated than either reference while reporting
 * ok. It also catches a limit that never MOVED — `shoreMaxRun` was recorded as
 * tightened to 0.055 and was actually still 0.16, because the edit was a string
 * replace that silently did not match.
 *
 * The number printed is how far the nearest reference sits from the nearer edge,
 * as a fraction of the bracket's width. Above about 80% means one side of the
 * bracket is decorative.
 *
 * Values here are the REF rows this tool prints; keep them in step with it.
 */
const REF_VALUES = {
  rotation: [112.5], monotone: [0.80], satDrop: [-0.557],
  deepSat: [0.741, 0.598], deepVal: [0.740, 0.753],
  wakeShare: [0.322], wakeRatio: [9138], coarse: [0.0173, 0.0378],
  fine: [0.0049, 0.0259], holeMax: [0.0342], fill: [0.562],
  laceRuns: [13.96], laceStroke: [0.0047], foamShare: [0.056],
  foamRatio: [12.22], cellSpread: [0.133], cellBorder: [0.157],
  solidRings: [35], shoreRuns: [1.95], shoreStroke: [0.0063],
  shoreMaxRun: [0.021],
}

function printLimits() {
  console.log('water — brackets against the references they were calibrated on\n')
  console.log('  metric          bracket              reference(s)      slack')
  console.log('  ' + '-'.repeat(74))
  const rows = []
  for (const [k, lim] of Object.entries(LIMITS)) {
    const refs = REF_VALUES[k]
    const br = `[${lim[0]}, ${lim[1]}]`
    if (!refs) { rows.push([2, `  ${k.padEnd(16)}${br.padEnd(21)}${'-'.padEnd(18)}NO REFERENCE`]); continue }
    // ROOM BEYOND THE OUTERMOST REFERENCE ON EACH SIDE, and the worse of the
    // two. Taking the max distance from either edge to any reference — the first
    // version — reports a reference sitting exactly ON a bracket edge as 100%
    // slack, because it is then far from the OTHER edge. `fine` did exactly that:
    // its ceiling is the cartoon reference's own 0.0259, which is as tight as an
    // edge can be, and the audit called it decorative.
    const span = lim[1] - lim[0]
    const hi = Math.max(...refs)
    const lo = Math.min(...refs)
    const worst = Math.max((lim[1] - hi) / span, (lo - lim[0]) / span)
    const flag = worst > 0.8 ? '  <-- one side is decorative' : ''
    rows.push([-worst,
      `  ${k.padEnd(16)}${br.padEnd(21)}${refs.join(', ').padEnd(18)}`
      + `${(worst * 100).toFixed(0)}%${flag}`])
  }
  rows.sort((a, b) => a[0] - b[0])
  for (const [, line] of rows) console.log(line)
  console.log('\n  slack = the room beyond the outermost reference, on whichever')
  console.log('  side has more, as a fraction of the bracket width. A gate is only')
  console.log('  as good as its looser side.')
}

/**
 * THE BOB RIPPLES — rings spreading from a floating hull, on `water-bob`.
 *
 * A REGRESSION GATE, not a reference one: `refs/water/` contains no floating
 * craft, so there is no reference profile to match and this must not claim one.
 * Its numbers come from the measured working state and from an A/B against the
 * feature switched off.
 *
 * IT MEASURES THE RADIAL FOAM PROFILE around the hull, in annuli, because that
 * is the only thing that distinguishes the three failure modes this feature
 * actually had:
 *
 *   invisible      the profile dies at the wake's own radius. Measured with the
 *                  ripples disabled entirely: 0.00% beyond 90 px, and identical
 *                  to the enabled build to three decimals — the ring apparently
 *                  present at 45-75 px is the decaying wake, not a ripple.
 *   a solid disc   the profile is a plateau: every annulus full, no troughs,
 *                  because the rings merged.
 *   working        alternating peaks and troughs, reaching well past the wake.
 *
 * So `reach` has a floor (it must extend past the wake) and `alt` has a floor
 * (there must be gaps between the rings). A plateau passes `reach` and fails
 * `alt`; an absent feature fails both.
 *
 * The hull is found by its cardboard hue, searched BELOW the horizon band — an
 * unrestricted search picks up the beach at the top of the frame and puts the
 * centre hundreds of pixels away, which silently makes every annulus wrong.
 */
function bobRipples(file) {
  const png = loadPng(file)
  const foam = (i) => {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const sat = mx ? (mx - mn) / mx : 0
    return sat < 0.12 && mx > 210
  }
  let bx = 0, by = 0, n = 0
  for (let y = Math.floor(png.height * 0.35); y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4
      const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2]
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const sat = mx ? (mx - mn) / mx : 0
      const [h] = rgbToHsv(r, g, b)
      if (h > 18 && h < 48 && sat > 0.38 && mx > 80 && mx < 235) { bx += x; by += y; n++ }
    }
  }
  if (n < 200) return null
  bx = Math.round(bx / n); by = Math.round(by / n)

  const STEP = 10
  const prof = []
  for (let r0 = 0; r0 < 200; r0 += STEP) {
    let f = 0, t = 0
    for (let y = Math.max(0, by - r0 - STEP); y < Math.min(png.height, by + r0 + STEP); y++) {
      for (let x = Math.max(0, bx - r0 - STEP); x < Math.min(png.width, bx + r0 + STEP); x++) {
        const d = Math.hypot(x - bx, y - by)
        if (d < r0 || d >= r0 + STEP) continue
        t++
        if (foam((y * png.width + x) * 4)) f++
      }
    }
    prof.push(t ? f / t : 0)
  }
  // Outermost annulus carrying real foam, in fractions of frame width.
  let last = 0
  for (let i = 0; i < prof.length; i++) if (prof[i] > 0.02) last = (i + 1) * STEP
  // Alternations OUTSIDE the hull froth: the hull's own collar occupies the
  // first few annuli and would otherwise count as a peak.
  const HULL = 4
  let alt = 0
  for (let i = HULL + 1; i < prof.length - 1; i++) {
    const a = prof[i - 1], b = prof[i], c = prof[i + 1]
    if ((b > a && b > c && b > 0.03) || (b < a && b < c && a > 0.03)) alt++
  }
  return { reach: last / png.width, alt, prof }
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}`
if (IS_MAIN) {
  if (process.argv.includes('--limits')) { printLimits(); process.exit(0) }
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  let fail = 0
  let ran = 0
  console.log('water — cartoon sea vs refs/water\n')
  for (const [key, spec] of Object.entries(FRAMES)) {
    const file = key.startsWith('refs/') ? key : `shots/${key}.png`
    if (only.length && !only.some((o) => key.includes(o))) continue
    if (!fs.existsSync(file)) {
      console.log(`  skip ${key.padEnd(38)} (no file)`)
      continue
    }
    ran++
    const isRef = key.startsWith('refs/')
    const r = analyse(file, spec)
    const tag = isRef ? 'REF ' : r.ok ? ' ok ' : 'FAIL'
    const bits = r.checks.map((c) =>
      `${c.name} ${fmt(c.value, c.digits)}${c.ok ? '' : '!'}`).join('  ')
    console.log(`  ${tag} ${key.padEnd(38)} ${bits}`)
    if (r.froth) console.log(`       wake froth hull ${r.froth.hull.toFixed(3)}`
      + `  holes ${r.froth.holes}  holeMax ${(r.froth.holeMax * 100).toFixed(2)}%W`
      + `  [diag fill ${r.froth.fill.toFixed(3)}]`)
    if (r.lace) console.log(`       wake stroke ${(r.lace.stroke * 100).toFixed(2)}%W`
      + `  [diag maxRun ${r.lace.maxRun.toFixed(3)}]`)
    if (r.shoreLace) console.log(`       shore stroke ${(r.shoreLace.stroke * 100).toFixed(2)}%W`
      + `  [diag maxRun ${r.shoreLace.maxRun.toFixed(3)}]`)
    if (r.cells) console.log(`       cells spread ${r.cells.spread.toFixed(3)}`
      + `  border ${r.cells.border.toFixed(3)}`
      + `  [diag plateau ${r.cells.plateau.toFixed(3)} edge ${r.cells.edge.toFixed(1)}]`)
    if (r.deep) console.log(`       deep ${r.deep.hex} H${r.deep.hue.toFixed(0)}`
      + ` S${r.deep.sat.toFixed(2)} V${r.deep.val.toFixed(2)}`)
    if (r.ladder) {
      console.log('       ladder ' + r.ladder.bands.map((b) =>
        `H${b.hue.toFixed(0)}/S${b.sat.toFixed(2)}`).join(' -> '))
    }
    // A reference that fails is a MIS-CALIBRATED GATE, not a bad reference.
    // CLAUDE.md: "Before trusting any new gate, run it against refs/ first.
    // Three of the five were mis-calibrated on the first write and only caught
    // that way." So a failing ref is a hard error and a failing shot is a fail.
    if (!r.ok) {
      fail++
      if (isRef) console.log('       ^^ THE GATE IS MIS-CALIBRATED: a reference must pass.')
    }
  }
  // THE SWASH, measured across a cycle rather than within a frame.
  const SW = [0, 1, 2, 3, 4, 5].map((i) => `shots/water-swash-${i}.png`)
  if ((!only.length || only.some((o) => o.includes('swash')))
      && SW.every((f) => fs.existsSync(f))) {
    const sw = swashSeries(SW)
    if (sw) {
      ran++
      const cs = [
        ['swashRange', sw.range, LIMITS.swashRange, 4],
        ['swashSand', sw.sand, LIMITS.swashSand, 4],
      ].map(([name, value, lim, digits]) => ({
        name, value, digits, ok: value >= lim[0] && value <= lim[1],
      }))
      const bad = cs.some((c) => !c.ok)
      console.log(`  ${bad ? 'FAIL' : ' ok '} ${'water-swash (series)'.padEnd(38)} `
        + cs.map((c) => `${c.name} ${fmt(c.value, c.digits)}${c.ok ? '' : '!'}`).join('  '))
      console.log('       swash wet coverage '
        + sw.cov.map((c) => c.toFixed(4)).join(' '))
      if (bad) fail++
    }
  }

  // THE BOB RIPPLES, on their own frame.
  const BOB = 'shots/water-bob.png'
  if ((!only.length || only.some((o) => o.includes('bob') || o.includes('ripple')))
      && fs.existsSync(BOB)) {
    const rp = bobRipples(BOB)
    if (rp) {
      ran++
      const cs = [
        ['rippleReach', rp.reach, LIMITS.rippleReach, 4],
        ['rippleAlt', rp.alt, LIMITS.rippleAlt, 0],
      ].map(([name, value, lim, digits]) => ({
        name, value, digits, ok: value >= lim[0] && value <= lim[1],
      }))
      const bad = cs.some((c) => !c.ok)
      console.log(`  ${bad ? 'FAIL' : ' ok '} ${'water-bob (ripples)'.padEnd(38)} `
        + cs.map((c) => `${c.name} ${fmt(c.value, c.digits)}${c.ok ? '' : '!'}`).join('  '))
      console.log('       radial foam '
        + rp.prof.slice(0, 15).map((v) => (v * 100).toFixed(0)).join(' '))
      if (bad) fail++
    }
  }

  if (ran === 0) console.log('  nothing to measure')
  console.log(fail ? `\n${fail} frame(s) fail` : '\nwater ok')
  process.exit(fail ? 1 : 0)
}
