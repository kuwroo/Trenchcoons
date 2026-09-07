// Silhouette profile comparison: the build's front view against the reference's.
//
// WHY. "The proportions look off" is not actionable and, on this character, has
// been wrong as often as right. What a modeller actually works to is a
// BLUEPRINT — the width of the silhouette at each height — and both the sheet
// and a render can be reduced to exactly that. Normalise both to the same total
// height and the comparison is a list of numbers with a sign on each, which
// says not just that a proportion is wrong but which way and by how much.
//
// It reads two PNGs and prints one table:
//   reference   refs/character/raccoon-boxkart-sheet-2.png, cropped to one of
//               its front-view raccoons and keyed off the flat grey ground
//   build       an ORTHOGRAPHIC front render from tools/_bl.py, keyed off its
//               own flat background
//
// Orthographic matters. A perspective render tapers with depth, so its
// silhouette is not the object's profile and cannot be compared with a flat
// drawing — a 70 mm lens at two metres was making the build's hips read about 4%
// narrow before this was noticed.
//
//   node tools/raccoon-profile.mjs [front|side|rear] [buildRender.png]
//
// READ THE ROWS AS SHAPE, NOT AS ANATOMY. Both subjects are normalised over
// their OWN total height, and that aligns anatomy only if both have the same
// head-height fraction. THEY DO NOT. This model is a BUST — round 20 hung a
// compact egg from the head with its base floating 0.42 m above the box floor,
// because nothing below the rim is ever seen — so ear-tip to chin is 0.771 of
// 1.345, i.e. 57% of its height, against the sheet's 48%. The sheet also has
// FEET and this has none.
//
// So a row index is NOT a landmark. Worked example, and it cost a round: the
// sheet's waist sits at frac 0.42, which is 87% of the way down the SHEET's
// head; in this model that is frac 0.50, y 1.15, the NECK. Fitted at frac 0.42
// directly it lands at y 1.24-1.27, the JAW — 0.10 m too high — and a taper
// undercut authored there narrowed the skull exactly where the mouth sits and
// turned the grin into a dark gash. Every per-row number was correct and the
// correspondence was not.
//
// To place something anatomically, convert through the head fraction:
//   build_frac = sheet_frac / 0.48 * 0.57      (within the head)
// or better, find the landmark in the geometry and work in metres. The widest
// ROW is also not comparable: the sheet's is at frac 0.295 (its cheek ruff) and
// this model's at 0.733 (its body), a 0.437 skew, so the normaliser itself is a
// different feature on each side.
//
// WHAT THE TABLE IS STILL GOOD FOR is the SHAPE of the curve — where it bulges,
// where it dips, whether a run is convex or straight — and any comparison of two
// extents measured on the same subject, like head width over body width, which
// is a ratio and immune to all of the above.

import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHEET = path.join(ROOT, 'refs/character/raccoon-boxkart-sheet-2.png')
/**
 * Where each of the sheet's views sits, found by blob detection.
 *
 * The side crop stops at x 1040 on purpose: past that is the TAIL, which lies
 * out behind the animal and would set the silhouette's width. The front view's
 * tail is hidden behind the body, which is why the build's render omits its own
 * tail — see the note in /tmp/ortho.py.
 */
const SHEET_BOXES = {
  front: { x0: 160, y0: 635, x1: 405, y1: 1010 },
  // x1 IS 1120, THE BODY/TAIL SEAM, MEASURED. It was 1040 with a note saying
  // "the side crop stops at x 1040 on purpose: past that is the TAIL, which
  // would set the silhouette's width" — and 1040 is 80 px SHORT of that, cutting
  // straight through the middle of the torso. Counting foreground rows per
  // column finds the seam unambiguously:
  //
  //   x     1090 1100 1110 | 1120 | 1130 1140 1150 1200 1220 1250
  //   rows   127  125  104 |  18  |   48   72   72   80   45    0
  //                 body   ^seam^        tail
  //
  // Fifteen of twenty-four sampled rows had foreground past 1040. So every side
  // measurement was normalised over a clipped subject, and the BODY rows were
  // clipped while the head's were not (the head's rightmost is 1037, just
  // inside) — which biases every body-relative reading DOWN and is the likely
  // source of the head/body depth ratio reading 1.65 here against 1.37 derived
  // from the same image's own profile.
  //
  // The other three edges were checked and are right: leftmost 805 is the nose,
  // topmost 647 the ear tip, and y1 1005 matches the front box, with the sheet's
  // FEET below it being the documented bust-vs-full-body skew rather than a clip.
  side: { x0: 805, y0: 647, x1: 1120, y1: 1005 },
  // NO REAR BOX, ON PURPOSE. There are two rear-view raccoons on the sheet and
  // BOTH have the tail lying across the bottom of the body, sweeping out to one
  // side. Our render excludes the tail (see the note above), so any crop either
  // includes a mass the build does not have, or clips the height to dodge the
  // tail — and clipping the height breaks the normalisation, which is the one
  // thing this tool depends on. The box that used to be here did the second, and
  // it landed entirely INSIDE the animal: it reported a solid 244 px on all 24
  // rows, a perfect rectangle, and nothing in the output said so.
  //
  // Render the rear view and LOOK at it. Its value is shading and surface — a
  // seam down the spine, faceting across the shoulders — none of which a
  // silhouette measures anyway.
}

/**
 * Rows of the silhouette, as (fraction of height from the top, width) with the
 * width normalised so the widest row is 1.
 *
 * Keyed on "differs from the most common colour", which is what both images
 * offer: the sheet is drawn on flat grey and the render sits on a flat
 * background. Anything within `tol` of that colour is outside the subject.
 */
function profile(png, box, tol, rows = 24) {
  const { width, height, data } = png
  const b = box ?? { x0: 0, y0: 0, x1: width, y1: height }
  const count = new Map()
  const at = (x, y) => {
    const i = (y * width + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
  for (let y = b.y0; y < b.y1; y += 3) {
    for (let x = b.x0; x < b.x1; x += 3) {
      const k = at(x, y).map((v) => v >> 3).join(',')
      count.set(k, (count.get(k) ?? 0) + 1)
    }
  }
  const bgKey = [...count.entries()].sort((p, q) => q[1] - p[1])[0][0]
  const bg = bgKey.split(',').map((v) => (Number(v) << 3) + 4)
  const isFg = (x, y) => {
    const c = at(x, y)
    return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > tol
  }
  // Tighten the box onto the subject first, so both images are measured over
  // their own extent rather than over whatever padding they happen to carry.
  let tx0 = b.x1, tx1 = b.x0, ty0 = b.y1, ty1 = b.y0
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      if (isFg(x, y)) {
        if (x < tx0) tx0 = x
        if (x > tx1) tx1 = x
        if (y < ty0) ty0 = y
        if (y > ty1) ty1 = y
      }
    }
  }
  const h = ty1 - ty0
  const out = []
  let widest = 0
  for (let r = 0; r < rows; r++) {
    const y = Math.round(ty0 + (h * (r + 0.5)) / rows)
    let lo = -1, hi = -1
    for (let x = tx0; x <= tx1; x++) {
      if (isFg(x, y)) { if (lo < 0) lo = x; hi = x }
    }
    const w = lo < 0 ? 0 : hi - lo
    if (w > widest) widest = w
    out.push(w)
  }
  return { rows: out.map((w) => w / (widest || 1)), aspect: (tx1 - tx0) / (h || 1), h }
}

const view = process.argv[2] ?? 'front'
if (view === 'rear') {
  console.error('rear is not measurable against this sheet — see SHEET_BOXES. '
    + 'Look at /tmp/ortho_build_rear.png instead.')
  process.exit(2)
}
if (!(view in SHEET_BOXES)) {
  console.error(`unknown view "${view}" — expected one of ${Object.keys(SHEET_BOXES).join(', ')}`)
  process.exit(2)
}
const sheet = profile(PNG.sync.read(fs.readFileSync(SHEET)), SHEET_BOXES[view], 46)
const buildPath = process.argv[3] ?? `/tmp/ortho_build_${view}.png`
const build = profile(PNG.sync.read(fs.readFileSync(buildPath)), null, 26)

console.log(`\n${view} silhouette, width per row, both normalised to their own widest\n`)
console.log('  row   top->bottom      sheet   build    delta')
let worst = 0, worstRow = 0
for (let r = 0; r < sheet.rows.length; r++) {
  const a = sheet.rows[r], b = build.rows[r], d = b - a
  if (Math.abs(d) > Math.abs(worst)) { worst = d; worstRow = r }
  const bar = (v) => '#'.repeat(Math.round(v * 22)).padEnd(22)
  console.log(`  ${String(r).padStart(2)}   ${bar(a)}  ${a.toFixed(2)}    ${b.toFixed(2)}   `
    + `${d >= 0 ? '+' : ''}${d.toFixed(2)}${Math.abs(d) > 0.12 ? '  <<' : ''}`)
}
console.log(`\n  aspect (w/h)   sheet ${sheet.aspect.toFixed(3)}   build ${build.aspect.toFixed(3)}`
  + `   delta ${(build.aspect - sheet.aspect >= 0 ? '+' : '')}${(build.aspect - sheet.aspect).toFixed(3)}`)
console.log(`  worst row      ${worstRow} of ${sheet.rows.length}  (${worst >= 0 ? '+' : ''}${worst.toFixed(2)}`
  + `, build is ${worst > 0 ? 'WIDER' : 'NARROWER'} there)\n`)
