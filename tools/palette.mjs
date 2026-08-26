// Quantitative reference comparison.
//
// "Compare against the reference" is worthless if it stays subjective — rounds
// circle on vibes. This reports hard numbers for the things ART_BIBLE actually
// specifies: saturation level, how washed-out the highlights are, whether
// saturation rises with luminance, and shadow neutrality.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-palette'
fs.mkdirSync(TMP, { recursive: true })

/** Decode anything (jpg/webp/avif/png) to a PNG buffer via macOS sips. */
function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (mx === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

export function analyse(file) {
  const png = loadPng(file)
  const n = png.width * png.height
  let sumS = 0, sumL = 0, blown = 0, nearGrey = 0, dark = 0
  const lums = []
  // HSV *value* (max channel), which is what "N stops of range" is measured in.
  const vals = []
  // saturation binned by luminance — tests the "saturation rises with light" rule
  const bins = Array.from({ length: 5 }, () => ({ s: 0, n: 0 }))
  // shadow pixels (darkest 15%) hue spread — tests "shadows are tinted"
  const shadowPx = []

  let d25 = 0, d35 = 0, minL = 1
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    const [h, s, l] = rgbToHsl(r, g, b)
    sumS += s; sumL += l
    if (l < minL) minL = l
    if (l < 0.25) d25++
    if (l < 0.35) d35++
    lums.push(l)
    vals.push(Math.max(r, g, b) / 255)
    if (l > 0.93) blown++
    if (l < 0.20) dark++
    if (s < 0.08) nearGrey++
    const bi = Math.min(4, Math.floor(l * 5))
    bins[bi].s += s; bins[bi].n++
    if (l < 0.35) shadowPx.push([h, s, l])
  }

  lums.sort((a, b) => a - b)
  vals.sort((a, b) => a - b)
  const q = (p) => lums[Math.floor(lums.length * p)] ?? 0
  const qv = (p) => vals[Math.floor(vals.length * p)] ?? 0
  const shadowS = shadowPx.length ? shadowPx.reduce((a, p) => a + p[1], 0) / shadowPx.length : 0
  // ── how many darks are there AT ALL ──────────────────────────────────────
  // Diagnostic, added because `shadowSat` cannot be read without it. A frame
  // with no pixels under HSL lightness 0.35 reports shadowSat 0.000, which
  // looked like "unmeasured" and was in fact "this picture has no shadows".
  // Reference band, measured over the four files above plus refs/snow:
  //   minL 0.002-0.157   %L<0.25 0.11-2.42   %L<0.35 2.8-11.2

  return {
    file: path.basename(file),
    meanSat: +(sumS / n).toFixed(3),
    meanLum: +(sumL / n).toFixed(3),
    p05: +q(0.05).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3),
    v05: +qv(0.05).toFixed(3), v95: +qv(0.95).toFixed(3),
    vRange: +(qv(0.95) - qv(0.05)).toFixed(3),
    blownPct: +((blown / n) * 100).toFixed(2),
    darkPct: +((dark / n) * 100).toFixed(2),
    nearGreyPct: +((nearGrey / n) * 100).toFixed(2),
    shadowSat: +shadowS.toFixed(3),
    /** How many pixels the shadowSat average is taken over, as a % of frame. */
    shadowPoolPct: +((shadowPx.length / n) * 100).toFixed(2),
    minL: +minL.toFixed(3),
    below25Pct: +((d25 / n) * 100).toFixed(2),
    below35Pct: +((d35 / n) * 100).toFixed(2),
    satByLum: bins.map((b) => +(b.n ? b.s / b.n : 0).toFixed(3)),
  }
}

// Only run the CLI when invoked directly. These modules are imported by
// tools/regress.mjs, and unguarded top-level output would fire on import.
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`
if (IS_MAIN) {

const REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/character/raccoon-artstyle-capycastaway.jpg',
]

function row(a) {
  const rising = a.satByLum[3] >= a.satByLum[1] ? 'yes' : 'NO '
  return [
    a.file.slice(0, 34).padEnd(34),
    String(a.meanSat).padStart(6),
    String(a.meanLum).padStart(6),
    String(a.shadowSat).padStart(7),
    String(a.blownPct).padStart(7),
    String(a.minL).padStart(6),
    String(a.below25Pct).padStart(7),
    String(a.below35Pct).padStart(7),
    String(a.v05).padStart(6),
    String(a.v95).padStart(6),
    String(a.vRange).padStart(7),
    rising.padStart(7),
    '  [' + a.satByLum.join(' ') + ']',
  ].join(' ')
}

const targets = process.argv.slice(2)
const shots = targets.length ? targets
  : fs.existsSync('shots') ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
  : []

console.log('file'.padEnd(34), 'mSat'.padStart(6), 'mLum'.padStart(6),
            'shdSat'.padStart(7), 'blown%'.padStart(7), 'minL'.padStart(6),
            '%L<.25'.padStart(7), '%L<.35'.padStart(7),
            'v05'.padStart(6), 'v95'.padStart(6), 'vRange'.padStart(7),
            'satRise'.padStart(7), '  sat by luminance bin')
console.log('-'.repeat(120))
console.log('REFERENCES')
const refStats = REFS.filter((f) => fs.existsSync(f)).map(analyse)
for (const a of refStats) console.log(row(a))

const refSat = refStats.reduce((a, r) => a + r.meanSat, 0) / Math.max(refStats.length, 1)
const refBlown = refStats.reduce((a, r) => a + r.blownPct, 0) / Math.max(refStats.length, 1)

console.log('\nOUTPUT')
const outStats = shots.map(analyse)
for (const a of outStats) console.log(row(a))

console.log('\nreference mean saturation: ' + refSat.toFixed(3) +
            '   reference mean blown%: ' + refBlown.toFixed(2))
console.log('VERDICT (per shot):')
let failed = 0
for (const a of outStats) {
  const problems = []
  if (a.meanSat < refSat * 0.75) problems.push(`undersaturated (${a.meanSat} vs ref ${refSat.toFixed(3)})`)
  if (a.blownPct > Math.max(refBlown * 2.5, 2)) problems.push(`washed out (${a.blownPct}% blown vs ref ${refBlown.toFixed(2)}%)`)
  if (a.nearGreyPct > 12) problems.push(`${a.nearGreyPct}% near-grey pixels`)
  // The reference band, measured: cliffs-tohad 0.51, genshin/grasslands 0.46,
  // desert-hazy 0.42. Below ~0.34 there is no terminator anywhere in frame.
  if (a.vRange < 0.34) problems.push(`FLAT — p05..p95 value range only ${a.vRange} (refs 0.42-0.51)`)
  // An EMPTY shadow pool is a failure, not an exemption.
  //
  // This read `if (a.shadowSat > 0 && ...)` for six rounds, and the guard was
  // load-bearing in the wrong direction: a frame with no pixel under HSL
  // lightness 0.35 reports shadowSat exactly 0.000 and therefore skipped the
  // tinted-shadow check entirely. Five shots held that exemption at the end of
  // round 6 — atmos-clouds-noon, atmos-dusk-sunward, atmos-golden-sunward,
  // greybox-sunrise and lagoon-morning — i.e. they passed "shadows are tinted"
  // by having no shadows at all, which is the one thing ART_BIBLE §2 says the
  // look cannot survive. Every reference carries 2.8-11.2% of its pixels below
  // that line. Enforcing the verdict this file already intends is not a new
  // threshold; the 0.25 below is exactly as it was written.
  if (a.below35Pct < 0.05) {
    problems.push(`NO SHADOW PIXELS AT ALL — ${a.below35Pct}% of the frame below HSL L 0.35, so shadowSat is measured over nothing (refs carry 2.8-11.2%)`)
  } else if (a.shadowSat < 0.25) {
    problems.push(`grey shadows (shadowSat ${a.shadowSat} over ${a.shadowPoolPct}% of frame, ART_BIBLE requires tinted)`)
  }
  if (a.satByLum[3] < a.satByLum[1]) problems.push('saturation FALLS with light (ART_BIBLE violation)')
  if (problems.length) failed++
  console.log('  ' + a.file.padEnd(30) + (problems.length ? 'FAIL  ' + problems.join('; ') : 'ok'))
}
// This script printed FAIL verdicts and exited 0 for four rounds — the only tool
// in tools/ with no exit code — so `npm run gate` reported green while palette
// was failing 9 of 13 shots, which is precisely how a 6 -> 9 palette regression
// shipped under a green gate. Enforcing the verdicts this file already prints is
// not a new threshold; every number above is exactly as it was written.
console.log(failed ? `\n${failed} shot(s) failing palette gate` : '\nall shots pass palette gate')
process.exit(failed ? 1 : 0)

}
