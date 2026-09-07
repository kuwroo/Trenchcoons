// The rendered SILHOUETTE EDGE, row by row, and its step sizes.
//
// WHY THIS EXISTS, and it is worth reading before touching the ruff again.
//
// `raccoon-profile.mjs` reports the silhouette's WIDTH per row against the
// sheet's. That answers "is the outline in the right place" and it cannot answer
// "is the outline notched", because a notch and a bulge of the same extent
// measure the same width. Six rounds of ruff work went into making the ruff read
// as fur; every one of them tuned the teeth's radial reach or their hashing, and
// NONE of it can appear in the outline at all. The reason is geometric:
//
//   THE RUFF'S TEETH VARY WITH AZIMUTH, AND AN ORTHOGRAPHIC SILHOUETTE IS THE
//   MAX OVER AZIMUTH. At each height the outline is set by whichever tooth
//   reaches furthest near the tangent point, so ~10 teeth in that angular window
//   are reduced to their envelope and the zigzag between them is erased. The
//   teeth are visible in SHADING — their facets catch the key light, which is
//   what three reviews were seeing when they called the ruff a spiked collar or
//   a gear — and they are invisible in the OUTLINE, which is what the reviews
//   that called it a slab, a poncho hem and a scarf groove were seeing.
//
// Measured on the build that prompted this file: over the whole cheek band the
// right edge climbed +3,+2,+3,+3 to a peak and fell -1,-2,-3,-5 — one smooth
// rounded bulge, monotone on each side, with no step anywhere in it. The only
// discontinuities in the entire head were the ear base and a single +14.
//
// So a notched outline needs the reach to vary with ELEVATION, not azimuth: the
// tufts have to run as lobes DOWN the cheek, which is exactly what the sheet
// draws ("four or five soft tufted bumps down each cheek", ART round 19) and is
// a different axis from the one that finding was implemented on.
//
// WHAT IT PRINTS. For each view, the outer edge of the silhouette per row, the
// step from the previous row, and then a summary: the number of DIRECTION
// REVERSALS in the head band and the largest inward step. A smooth bulge has 1-2
// reversals; a scalloped edge has one per lobe. That count is the number to
// watch, and it is a floor-and-ceiling quantity like every other gate here —
// too few is a slab, too many is noise.
//
//   node tools/raccoon-outline.mjs [front|side|rear] [--rows]
//
// It reads the renders `raccoon-ortho.py` leaves in /tmp, so run
// `npm run raccoon:ortho` first or the numbers are from the previous export.

import fs from 'node:fs'
import { PNG } from 'pngjs'

const view = process.argv[2] ?? 'front'
const showRows = process.argv.includes('--rows')
const path = `/tmp/ortho_build_${view}.png`
if (!fs.existsSync(path)) {
  console.error(`no render at ${path} — run "npm run raccoon:ortho" first`)
  process.exit(2)
}
const png = PNG.sync.read(fs.readFileSync(path))
const { width, height, data } = png
const at = (x, y) => {
  const i = (y * width + x) * 4
  return [data[i], data[i + 1], data[i + 2]]
}

// Background is the most common colour, same key as raccoon-profile.mjs.
const count = new Map()
for (let y = 0; y < height; y += 2) {
  for (let x = 0; x < width; x += 2) {
    const k = at(x, y).map((v) => v >> 3).join(',')
    count.set(k, (count.get(k) ?? 0) + 1)
  }
}
const bgKey = [...count.entries()].sort((p, q) => q[1] - p[1])[0][0]
const bg = bgKey.split(',').map((v) => (Number(v) << 3) + 4)
const isFg = (x, y) => {
  const c = at(x, y)
  return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 26
}

let y0 = height, y1 = 0, x0 = width, x1 = 0
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (isFg(x, y)) {
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
    }
  }
}
const H = y1 - y0

/** The outer edge on each side, per row, as a pixel column. */
const edge = []
for (let y = y0; y <= y1; y++) {
  let lo = -1, hi = -1
  for (let x = x0; x <= x1; x++) if (isFg(x, y)) { if (lo < 0) lo = x; hi = x }
  edge.push({ y, frac: (y - y0) / H, lo, hi })
}

/**
 * The HEAD BAND. The ruff is what this tool is for and it sits in the upper
 * half; below the box rim nothing is ever seen anyway. Bounded away from the
 * very top because the ear tips are a separate feature with their own steps, and
 * a reversal counter that includes the ear/cranium junction always reports one
 * reversal it did not find.
 */
const BAND = { lo: 0.22, hi: 0.52 }
const band = edge.filter((e) => e.frac >= BAND.lo && e.frac <= BAND.hi)

if (showRows) {
  console.log(`\n${view}: outer edge per row (subject rows ${y0}-${y1}, cols ${x0}-${x1})\n`)
  console.log('   row   frac    left  right   dRight')
  let prev = null
  for (const e of edge) {
    const d = prev === null ? 0 : e.hi - prev
    prev = e.hi
    console.log(`  ${String(e.y).padStart(4)}  ${e.frac.toFixed(3)}  ${String(e.lo).padStart(5)}`
      + `  ${String(e.hi).padStart(5)}   ${d >= 0 ? '+' : ''}${d}`)
  }
}

/**
 * Direction reversals, on a SMOOTHED edge.
 *
 * The raw edge steps by a pixel either way from anti-aliasing and from the
 * facets of a low-poly surface, so counting sign changes on it counts noise —
 * it reported 40-plus reversals on an edge that is visibly one smooth arc. A
 * 9-row box filter removes that without touching a lobe, which is tens of rows
 * across, and the threshold below ignores runs shorter than 3 px of travel.
 */
function reversals(vals, tol = 3) {
  const k = 9
  const sm = vals.map((_, i) => {
    let s = 0, n = 0
    for (let j = Math.max(0, i - (k >> 1)); j <= Math.min(vals.length - 1, i + (k >> 1)); j++) { s += vals[j]; n++ }
    return s / n
  })
  // RESOLVE THE INITIAL DIRECTION EXPLICITLY. The first version of this tracked
  // one `peak` under `dir === 0`, where both `dir >= 0` and `dir <= 0` are true —
  // so peak followed the value on every step, the deviation was always 0, and
  // `dir` could never leave 0. It returned 0 reversals for EVERY input, including
  // a ruff probed at 2.5x amplitude with the lobe closing fully onto the skull.
  // It looked exactly like a confirmed negative result. Self-test below.
  let i0 = 0
  while (i0 < sm.length && Math.abs(sm[i0] - sm[0]) <= tol) i0++
  if (i0 >= sm.length) return 0
  let dir = sm[i0] > sm[0] ? 1 : -1
  let ext = sm[i0]
  let turns = 0
  for (let i = i0 + 1; i < sm.length; i++) {
    const v = sm[i]
    if (dir > 0) {
      if (v > ext) ext = v
      else if (v < ext - tol) { turns++; dir = -1; ext = v }
    } else {
      if (v < ext) ext = v
      else if (v > ext + tol) { turns++; dir = 1; ext = v }
    }
  }
  return turns
}

/**
 * SELF-TEST, because this file's first version of `reversals` returned 0 for
 * every possible input and that is indistinguishable from a real finding. Run
 * with --selftest. A gate that cannot fail is worse than none — CLAUDE.md says
 * so twice, about two different gates that shipped passing with their feature
 * switched off.
 */
if (process.argv.includes('--selftest')) {
  const cases = [
    ['flat', Array.from({ length: 200 }, () => 100), 0],
    ['one smooth bulge', Array.from({ length: 200 }, (_, i) => 100 + 40 * Math.sin((i / 199) * Math.PI)), 1],
    ['monotone ramp', Array.from({ length: 200 }, (_, i) => 100 + i * 0.4), 0],
    ['4 lobes on a ramp', Array.from({ length: 200 }, (_, i) =>
      100 + i * 0.2 + 14 * Math.sin((i / 199) * 4 * Math.PI * 2)), 8],
    ['1px noise only', Array.from({ length: 200 }, (_, i) => 100 + (i % 2)), 0],
  ]
  let bad = 0
  for (const [name, series, want] of cases) {
    const got = reversals(series)
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} want ${want}  got ${got}`)
  }
  process.exit(bad ? 1 : 0)
}

const right = band.map((e) => e.hi)
const left = band.map((e) => -e.lo)
const rTurns = reversals(right)
const lTurns = reversals(left)
const span = Math.max(...right) - Math.min(...right)

console.log(`\n${view} outline, head band frac ${BAND.lo}-${BAND.hi} (${band.length} rows)\n`)
console.log(`  edge travel (right)     ${span} px over ${band.length} rows`)
console.log(`  direction reversals     right ${rTurns}   left ${lTurns}`)
console.log(`  interpretation          ${rTurns + lTurns <= 3
  ? 'ONE SMOOTH BULGE — the outline carries no tufts. A radial (azimuthal)\n'
    + '                          jag cannot fix this; the reach has to vary with ELEVATION.'
  : `${rTurns} and ${lTurns} lobes down the two cheeks — the outline is scalloped.`}`)
console.log()
