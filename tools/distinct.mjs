// Are the shots actually different pictures — and, for a declared A/B pair, is
// the difference in the place the shot claims it is?
//
// Round 1 shipped `sunDirection()` mapping tod 0.25 and 0.75 to the same solar
// elevation with a mirrored azimuth, so every scalar derived from the sun's
// height was bit-identical at the two ends of the day and greybox-sunrise /
// greybox-dusk came out as the same frame (mean abs diff 11/255). Two of eight
// shots carried no information and nothing in the harness noticed. This does.
import fs from 'node:fs'
import { PNG } from 'pngjs'

/**
 * Below this mean per-channel difference, two shots are the same picture.
 *
 * Calibrated, not guessed. Round 1's degenerate pairs — where sunDirection()
 * genuinely returned the same solar elevation for two different hours — scored
 * 9.7 and 11.3. Adjacent rungs of the current five-elevation ladder score
 * 17-25, and a mean-abs-diff over the whole frame mostly measures level, so it
 * cannot be expected to separate 22deg of sun from 7deg by much more than that.
 * 14 leaves clear margin over the real failure and does not punish a dense
 * ladder for being dense.
 */
const MIN_DIFF = 14

/**
 * The gate applies to the fixed-camera time-of-day ladder only.
 *
 * That is where round 1's collapse was: same camera, five different hours, two
 * of them numerically identical. Two shots at the SAME hour from different
 * cameras legitimately share their whole colour register — a mean-abs-diff over
 * the frame mostly measures level, so it cannot separate them and should not be
 * asked to. Every pair is still reported.
 */
const LADDER = /^shots\/greybox-/

/**
 * CONTROLLED PAIRS — the other failure mode, and the one that shipped.
 *
 * `MIN_DIFF` above asks "are these two different pictures". That is the right
 * question for a time-of-day ladder and exactly the WRONG one for an A/B, where
 * two frames are supposed to be identical apart from the one thing under test.
 * Extending the ladder regex to `tracks-` — which is what was asked for — would
 * gate the pair on being far apart, i.e. it would reward the very defect being
 * fixed here.
 *
 * What actually failed review: `tracks-fresh` / `tracks-decay` were captured
 * 660 frames apart with the car still rolling, so the chase camera moved 1.5 m,
 * 94% of the pixels differed, the SKY alone differed by a mean of 14.5/255, and
 * the whole-frame difference measured the camera rather than the decay. The
 * pair looked "distinct" by every number in this file while demonstrating
 * nothing.
 *
 * So the gate is a RATIO, and it is two-sided by construction. For each declared
 * pair the difference is measured in two places: the SUBJECT box (where the
 * thing under test lives) and a CONTROL box of ground at the same depth and the
 * same lighting where nothing should have changed. A pair passes only if the
 * subject moved and the control did not.
 *
 *   - camera drift, brightness drift, a different hour: control rises with
 *     subject, ratio collapses toward 1, FAIL
 *   - the tracks did not actually decay: subject falls to the control's level,
 *     ratio collapses toward 1, FAIL
 *
 * CALIBRATED ON THE REJECTED CAPTURE, which is the only honest way to set it:
 * the pair the critics rejected scores subject 19.27, control 18.94, ratio 1.02.
 * The pair that replaces it scores subject 8.65, control 1.97, ratio 4.39. The
 * threshold sits between those two at 2.0, nearer the failure than the pass.
 */
const MIN_SUBJECT_RATIO = 2.0

/**
 * …and the two SIDES the ratio alone does not have. CLAUDE.md: "Every gate
 * needs a floor AND a ceiling. A one-sided metric is an invitation to optimise
 * the proxy instead of the goal."
 *
 * A bare ratio has exactly that hole. A pair scoring subject 0.4 / control 0.05
 * — nothing visible in either frame, the deformation field deleted — scores 8
 * and passes. So:
 *
 *   MIN_SUBJECT  an absolute floor on the subject box. Calibrated below the
 *                8.65 the previous round's pair scored, which reviewers agreed
 *                showed a readable mark; today's pair scores 14.50.
 *   MAX_CONTROL  a ceiling on the box where NOTHING is supposed to have moved.
 *                This is the term that catches the original defect directly
 *                rather than by proportion: the rejected capture drifted its
 *                camera and scored control 18.94, and a big enough subject
 *                could have carried it through the ratio anyway. Today 1.90.
 *
 * Both are set between the measured failure and the measured pass, nearer the
 * failure, the same way MIN_SUBJECT_RATIO was.
 */
const MIN_SUBJECT = 6.0
const MAX_CONTROL = 6.0

/**
 * name -> { a, b, subject, control }, boxes in fractions of the frame as
 * [x0, x1, y0, y1].
 *
 * The subject box is the corridor the tyre marks run down — the chase camera
 * looks along the car's forward axis, so the track between the camera and the
 * car is the middle third of the lower frame. The control boxes are the sand to
 * either side of it: same surface, same distance, same light, no marks.
 */
const CONTROLLED = [{
  name: 'deform decay',
  a: 'shots/tracks-fresh.png',
  b: 'shots/tracks-decay.png',
  subject: [0.33, 0.67, 0.60, 1.0],
  control: [[0, 0.25, 0.60, 1.0], [0.75, 1.0, 0.60, 1.0]],
}]

/**
 * Within-frame subject-vs-control.
 *
 * Persistence has failed review three rounds running and was never gated: the
 * only controlled pair here compares two FRAMES, and "did the mark survive a
 * round trip" is a property of ONE frame — is there still a corridor in the
 * sand where the car drove, or is it bare?
 *
 * Comparing the corridor's own local contrast against adjacent untouched sand
 * in the same image needs no second capture, and cannot be satisfied by
 * changing the whole surface — the loophole an absolute threshold would leak.
 */
const WITHIN = [{
  name: 'deform persistence',
  file: 'shots/tracks-persist.png',
  // Aimed at the COMMITTED BAND, which is what this shot exists to show.
  //
  // The first version of this window was aimed at nothing. I picked
  // subject x 0.33-0.67 / control x<0.25 and x>0.75 by eye, from the assumption
  // that "the marks are behind the car". A critic then built a validated
  // world->screen projection (car origin lands on the drawn kart; fresh-trail
  // centreline lands on the two visible dark lines), probed the CPU mirror on a
  // 0.5 m grid, and found the committed band at world x -974..-969, z 121..143,
  // projecting to screen x 0-675 / y 697-804 of 1600x900.
  //
  // Against that footprint my window put 16% of the band in the SUBJECT and 68%
  // in the CONTROL. The gate was scoring the fresh trail as its subject and the
  // persisted band as its control — reporting ratio 1.54 PASS on a frame whose
  // named subject is invisible, and, worse, a band that became visible would
  // raise the control and make the gate HARDER to pass. That is precisely the
  // gate-fights-feature failure recorded in CLAUDE.md, committed one tick after
  // I wrote that warning, on the metric written to stop this shipping unseen.
  subject: [0.0, 0.42, 0.77, 0.89],
  // Bare sand at the SAME depth band — depth changes brush LOD, so a control on
  // a different screen row is not a control.
  control: [[0.72, 1.0, 0.77, 0.89]],
  // The band measures mean luma 172.0 against 180.6 for adjacent sand: an
  // 8.6/255 dip under brushwork of sd 20.1, signal-to-noise 0.43. This gate is
  // EXPECTED TO FAIL until shade()'s knife-edge curve stops crushing low mask
  // values (stored 0.28 renders at 0.185, a 2.44x suppression; 0.22 suppresses
  // 14x). A correctly-failing gate is worth more than a falsely-passing one.
  min: 1.25,
}]

const files = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
).sort()

const imgs = files.map((f) => ({ f, png: PNG.sync.read(fs.readFileSync(f)) }))

function meanAbsDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity
  let sum = 0
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2])
  }
  return sum / ((a.data.length / 4) * 3)
}

const pairs = []
for (let i = 0; i < imgs.length; i++) {
  for (let j = i + 1; j < imgs.length; j++) {
    pairs.push({
      a: imgs[i].f, b: imgs[j].f,
      d: +meanAbsDiff(imgs[i].png, imgs[j].png).toFixed(2),
    })
  }
}
pairs.sort((x, y) => x.d - y.d)

console.log('closest pairs (mean abs channel diff, 0-255):')
for (const p of pairs.slice(0, 8)) {
  const ladder = LADDER.test(p.a) && LADDER.test(p.b)
  const flag = p.d < MIN_DIFF ? (ladder ? '  TOO SIMILAR' : '  (same hour, not gated)') : ''
  console.log(`  ${p.d.toFixed(2).padStart(7)}  ${p.a}  vs  ${p.b}${flag}`)
}
const bad = pairs.filter(
  (p) => p.d < MIN_DIFF && LADDER.test(p.a) && LADDER.test(p.b),
)
console.log(bad.length
  ? `\nFAIL: ${bad.length} TOD-ladder pair(s) below ${MIN_DIFF}`
  : `\nok: every TOD-ladder pair differs by >= ${MIN_DIFF}`)

// ── controlled pairs ────────────────────────────────────────────────────────
function boxDiff(a, b, [x0, x1, y0, y1]) {
  const W = a.width, H = a.height
  let sum = 0, n = 0
  for (let y = Math.round(y0 * H); y < Math.round(y1 * H); y++) {
    for (let x = Math.round(x0 * W); x < Math.round(x1 * W); x++) {
      const i = (y * W + x) * 4
      sum += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
      n++
    }
  }
  return sum / Math.max(n, 1)
}

let badPairs = 0
const present = new Set(files)
const checked = CONTROLLED.filter((c) => present.has(c.a) && present.has(c.b))
if (checked.length) {
  console.log('\ncontrolled pairs (subject vs control, mean abs channel diff):')
  for (const c of checked) {
    const A = imgs.find((i) => i.f === c.a).png
    const B = imgs.find((i) => i.f === c.b).png
    if (A.width !== B.width || A.height !== B.height) {
      console.log(`  ${c.name}: size mismatch`); badPairs++; continue
    }
    const subject = boxDiff(A, B, c.subject)
    const control = c.control.reduce((s, r) => s + boxDiff(A, B, r), 0) / c.control.length
    const ratio = subject / Math.max(control, 1e-6)
    const why = []
    if (ratio < MIN_SUBJECT_RATIO) why.push(`ratio < ${MIN_SUBJECT_RATIO}`)
    if (subject < MIN_SUBJECT) why.push(`subject < ${MIN_SUBJECT} (nothing in the subject box)`)
    if (control > MAX_CONTROL) why.push(`control > ${MAX_CONTROL} (the frame moved, not the subject)`)
    const ok = why.length === 0
    if (!ok) badPairs++
    console.log(`  ${c.name.padEnd(16)} subject ${subject.toFixed(2)}  control ` +
      `${control.toFixed(2)}  ratio ${ratio.toFixed(2)}` +
      (ok ? '' : `  NOT A CONTROLLED A/B — ${why.join('; ')}`))
    console.log(`    ${c.a}  vs  ${c.b}`)
  }
  console.log(badPairs
    ? `\nFAIL: ${badPairs} controlled pair(s) whose difference is not in the subject`
    : '\nok: every controlled pair changed its subject and nothing else')
}

// ── within-frame subject vs control ────────────────────────────────────────
function bandStd(png, [x0, x1, y0, y1]) {
  const { width: W, height: H, data } = png
  const vals = []
  for (let y = Math.floor(H * y0); y < Math.floor(H * y1); y += 2) {
    for (let x = Math.floor(W * x0); x < Math.floor(W * x1); x += 2) {
      const i = (y * W + x) * 4
      vals.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255)
    }
  }
  const m = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(vals.length, 1))
}

let badWithin = 0
if (WITHIN.length) {
  console.log('\nwithin-frame (subject vs adjacent control, local contrast):')
  for (const w of WITHIN) {
    if (!fs.existsSync(w.file)) {
      console.log(`  ${w.name.padEnd(20)} SKIPPED — ${w.file} not captured`)
      continue
    }
    const png = PNG.sync.read(fs.readFileSync(w.file))
    const subj = bandStd(png, w.subject)
    const ctrl = w.control.reduce((a, c) => a + bandStd(png, c), 0) / w.control.length
    const ratio = subj / Math.max(ctrl, 1e-6)
    const ok = ratio >= w.min
    if (!ok) badWithin++
    console.log(`  ${w.name.padEnd(20)} subject ${subj.toFixed(4)}  control ${ctrl.toFixed(4)}` +
      `  ratio ${ratio.toFixed(2)}` +
      (ok ? '  ok' : `  NO MARK IN THE SUBJECT (need >= ${w.min})`))
    console.log(`    ${w.file}`)
  }
}

// ── corridor local contrast: is the MARK the loudest thing in the corridor? ──
//
// The gate this round exists for, and the one whose absence let the last round
// ship. Every check above is satisfied by a difference BETWEEN two frames; none
// of them asks whether that difference is larger than the surface's own texture
// at the same spatial scale. It was not: with `regionStep` at 0.85 the sand pan
// carried tonal masses as loud as a tyre track, so `tracks-fresh` measured
// LOWER corridor local contrast (16.30) than `tracks-decay` (15.38 — within
// noise of it, and by the critics' own measurement the wrong way round), and
// gradRatio scored the frame WITHOUT marks higher than the frame with them.
//
// The metric is the critics': mean |L - boxblur(r=60)| x100 over the track
// corridor. A box blur at 60 px is a high-pass at roughly the scale a tyre mark
// subtends at this camera, so it measures exactly the competition — mark
// against ground texture — that the whole-frame statistics average away.
//
// TWO-SIDED, and both sides are load-bearing:
//   MIN_RATIO   fresh must beat decay. Catches "the surface out-shouts the
//               marks", which is what happened.
//   MAX_BARE    decay — a frame of BARE sand — has a ceiling on its own local
//               contrast. Catches the same defect from the other end, and it is
//               the term a future round cannot satisfy by simply cranking the
//               mark darker while leaving the camouflage in place.
//
// CALIBRATION. There is no reference PAIR to calibrate a ratio against — no
// image in refs/ shows the same ground with and without marks — so the ratio is
// set from the measured failure and the measured pass, the same discipline
// MIN_SUBJECT_RATIO uses: rejected 1.06, current 1.54, threshold 1.25. MAX_BARE
// is calibrated against refs/mkw/beach-wet-sand-tracks.jpg, which scores 18.85
// on this metric over the same box WITH its tracks and its foam and its HUD
// minimap inside the box; 20 is a ceiling that image would pass and the
// rejected build's bare sand (15.38, all of it camouflage) sits under — so this
// term is the loose one of the two and it is the ratio that does the work.
const CORRIDOR = [{
  name: 'deform corridor',
  fresh: 'shots/tracks-fresh.png',
  bare: 'shots/tracks-decay.png',
  box: [0.30, 0.70, 0.62, 1.00],
  minRatio: 1.25,
  maxBare: 20,
}]

/** Separable box blur, clamped at the edges. */
function boxBlur(src, W, H, r) {
  const tmp = new Float64Array(W * H), out = new Float64Array(W * H)
  const cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v)
  for (let y = 0; y < H; y++) {
    const row = y * W
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + cl(x, W - 1)]
    for (let x = 0; x < W; x++) {
      tmp[row + x] = acc / (2 * r + 1)
      acc -= src[row + cl(x - r, W - 1)]
      acc += src[row + cl(x + r + 1, W - 1)]
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[cl(y, H - 1) * W + x]
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1)
      acc -= tmp[cl(y - r, H - 1) * W + x]
      acc += tmp[cl(y + r + 1, H - 1) * W + x]
    }
  }
  return out
}

function corridorContrast(png, [x0, x1, y0, y1], r = 60) {
  const { width: W, height: H, data } = png
  const L = new Float64Array(W * H)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    L[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  const B = boxBlur(L, W, H, r)
  let sum = 0, n = 0
  for (let y = Math.round(y0 * H); y < Math.round(y1 * H); y++) {
    for (let x = Math.round(x0 * W); x < Math.round(x1 * W); x++) {
      sum += Math.abs(L[y * W + x] - B[y * W + x]); n++
    }
  }
  return sum / Math.max(n, 1)
}

let badCorridor = 0
const corridorChecked = CORRIDOR.filter(
  (c) => fs.existsSync(c.fresh) && fs.existsSync(c.bare),
)
if (corridorChecked.length) {
  console.log('\ncorridor local contrast (mean |L - boxblur(r=60)|, marks vs bare):')
  for (const c of corridorChecked) {
    const f = corridorContrast(PNG.sync.read(fs.readFileSync(c.fresh)), c.box)
    const b = corridorContrast(PNG.sync.read(fs.readFileSync(c.bare)), c.box)
    const ratio = f / Math.max(b, 1e-6)
    const why = []
    if (ratio < c.minRatio) {
      why.push(`marks add only ${ratio.toFixed(2)}x the bare surface's own contrast `
        + `(need >= ${c.minRatio}) — the ground is out-shouting the deformation`)
    }
    if (b > c.maxBare) why.push(`bare surface contrast ${b.toFixed(2)} > ${c.maxBare} (camouflage)`)
    if (why.length) badCorridor++
    console.log(`  ${c.name.padEnd(20)} marks ${f.toFixed(2)}  bare ${b.toFixed(2)}`
      + `  ratio ${ratio.toFixed(2)}` + (why.length ? `  FAIL — ${why.join('; ')}` : '  ok'))
    console.log(`    ${c.fresh}  vs  ${c.bare}`)
  }
}

process.exit(bad.length || badPairs || badWithin || badCorridor ? 1 : 0)
