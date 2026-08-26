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
  subject: [0.33, 0.67, 0.60, 1.0],
  control: [[0, 0.25, 0.60, 1.0], [0.75, 1.0, 0.60, 1.0]],
  // Gentle on purpose: this catches "no marks at all", it does not legislate
  // their depth.
  //
  // KNOWN CONFOUND: at this camera the kart's cast shadow runs straight down
  // the same corridor, so a passing ratio does NOT by itself prove the marks
  // survived — it proves the corridor is not bare. Reading 1.54 against a 1.25
  // floor, and the shadow alone could account for that. To make this decisive
  // the shot needs a sun azimuth that throws the shadow across the corridor
  // rather than along it; until then treat a pass here as necessary, not
  // sufficient, and confirm persistence by eye.
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
    const ok = ratio >= MIN_SUBJECT_RATIO
    if (!ok) badPairs++
    console.log(`  ${c.name.padEnd(16)} subject ${subject.toFixed(2)}  control ` +
      `${control.toFixed(2)}  ratio ${ratio.toFixed(2)}` +
      (ok ? '' : `  NOT A CONTROLLED A/B (need >= ${MIN_SUBJECT_RATIO})`))
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

process.exit(bad.length || badPairs || badWithin ? 1 : 0)
