// Are the eight shots actually eight different pictures?
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
process.exit(bad.length ? 1 : 0)
