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
  // saturation binned by luminance — tests the "saturation rises with light" rule
  const bins = Array.from({ length: 5 }, () => ({ s: 0, n: 0 }))
  // shadow pixels (darkest 15%) hue spread — tests "shadows are tinted"
  const shadowPx = []

  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    const [h, s, l] = rgbToHsl(r, g, b)
    sumS += s; sumL += l
    lums.push(l)
    if (l > 0.93) blown++
    if (l < 0.20) dark++
    if (s < 0.08) nearGrey++
    const bi = Math.min(4, Math.floor(l * 5))
    bins[bi].s += s; bins[bi].n++
    if (l < 0.35) shadowPx.push([h, s, l])
  }

  lums.sort((a, b) => a - b)
  const q = (p) => lums[Math.floor(lums.length * p)] ?? 0
  const shadowS = shadowPx.length ? shadowPx.reduce((a, p) => a + p[1], 0) / shadowPx.length : 0

  return {
    file: path.basename(file),
    meanSat: +(sumS / n).toFixed(3),
    meanLum: +(sumL / n).toFixed(3),
    p05: +q(0.05).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3),
    blownPct: +((blown / n) * 100).toFixed(2),
    darkPct: +((dark / n) * 100).toFixed(2),
    nearGreyPct: +((nearGrey / n) * 100).toFixed(2),
    shadowSat: +shadowS.toFixed(3),
    satByLum: bins.map((b) => +(b.n ? b.s / b.n : 0).toFixed(3)),
  }
}

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
    String(a.darkPct).padStart(6),
    String(a.nearGreyPct).padStart(8),
    rising.padStart(7),
    '  [' + a.satByLum.join(' ') + ']',
  ].join(' ')
}

const targets = process.argv.slice(2)
const shots = targets.length ? targets
  : fs.existsSync('shots') ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
  : []

console.log('file'.padEnd(34), 'mSat'.padStart(6), 'mLum'.padStart(6),
            'shdSat'.padStart(7), 'blown%'.padStart(7), 'dark%'.padStart(6), 'grey%'.padStart(8),
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
for (const a of outStats) {
  const problems = []
  if (a.meanSat < refSat * 0.75) problems.push(`undersaturated (${a.meanSat} vs ref ${refSat.toFixed(3)})`)
  if (a.blownPct > Math.max(refBlown * 2.5, 2)) problems.push(`washed out (${a.blownPct}% blown vs ref ${refBlown.toFixed(2)}%)`)
  if (a.nearGreyPct > 12) problems.push(`${a.nearGreyPct}% near-grey pixels`)
  if (a.darkPct < 0.5) problems.push(`NO SHADOWS — only ${a.darkPct}% of pixels below L=0.2`)
  else if (a.shadowSat > 0 && a.shadowSat < 0.25) problems.push(`grey shadows (shadowSat ${a.shadowSat}, ART_BIBLE requires tinted)`)
  if (a.satByLum[3] < a.satByLum[1]) problems.push('saturation FALLS with light (ART_BIBLE violation)')
  console.log('  ' + a.file.padEnd(30) + (problems.length ? 'FAIL  ' + problems.join('; ') : 'ok'))
}
