// Shadow-lift gate.
//
// ART_BIBLE §2 requires shadows that are "coloured AND lifted". The palette
// gate only tested "coloured" (shadowSat) and dynamic range (vRange), which a
// builder can satisfy by making shadows dark and heavily saturated — the exact
// overcorrection round 2 produced, where lit grass fell to near-navy in shade.
//
// The trap: HSV value = max(r,g,b), so a saturated navy rgb(45,70,130) scores
// value 0.51 and looks "not dark" to a value-based metric while reading as
// almost black to the eye. Perceived lightness needs Rec.709 luma, and hue
// drift needs measuring separately from lightness.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-shadow'
fs.mkdirSync(TMP, { recursive: true })

function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/** Dominant hue in degrees, and saturation, for a mean RGB. */
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (d === 0) return 0
  let h
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0))
  else if (mx === g) h = ((b - r) / d + 2)
  else h = ((r - g) / d + 4)
  return (h * 60 + 360) % 360
}

export function analyse(file) {
  const png = loadPng(file)
  const px = []
  for (let i = 0; i < png.data.length; i += 16) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    px.push({ r, g, b, y: luma(r, g, b) })
  }
  px.sort((a, b) => a.y - b.y)
  const take = (arr) => {
    const n = Math.max(arr.length, 1)
    const m = arr.reduce((a, p) => ({ r: a.r + p.r, g: a.g + p.g, b: a.b + p.b, y: a.y + p.y }),
                         { r: 0, g: 0, b: 0, y: 0 })
    return { r: m.r / n, g: m.g / n, b: m.b / n, y: m.y / n }
  }
  const nq = Math.floor(px.length * 0.2)
  const shadow = take(px.slice(0, nq))
  const lit = take(px.slice(-nq))

  return {
    file: path.basename(file),
    shadowLuma: +shadow.y.toFixed(3),
    litLuma: +lit.y.toFixed(3),
    // How far the darkest fifth sits off black relative to the lit fifth.
    lift: +(shadow.y / Math.max(lit.y, 1e-6)).toFixed(3),
    shadowHue: Math.round(hueOf(shadow.r, shadow.g, shadow.b)),
    litHue: Math.round(hueOf(lit.r, lit.g, lit.b)),
    hueDrift: (() => {
      const d = Math.abs(hueOf(shadow.r, shadow.g, shadow.b) - hueOf(lit.r, lit.g, lit.b))
      return Math.round(Math.min(d, 360 - d))
    })(),
  }
}

// Cohorts matter. The raccoon close-up is a character portrait with a genuinely
// dark background (shadowLuma 0.154); including it in a landscape cohort drags
// the floor down far enough to make the gate toothless. Judge landscapes
// against landscapes.
const COHORTS = {
  landscape: [
    'refs/painterly/cliffs-tohad.jpg',
    'refs/capycastaway/water-lagoon.webp',
    'refs/genshin/grasslands.jpg',
    'refs/painterly/desert-hazy.jpeg',
  ],
  character: ['refs/character/raccoon-artstyle-capycastaway.jpg'],
}
const COHORT = process.env.COHORT ?? 'landscape'
const REFS = (COHORTS[COHORT] ?? COHORTS.landscape).filter(fs.existsSync)

const shots = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.existsSync('shots') ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
  : []

const row = (a) => [
  a.file.slice(0, 34).padEnd(34),
  String(a.shadowLuma).padStart(10),
  String(a.litLuma).padStart(8),
  String(a.lift).padStart(6),
  String(a.shadowHue).padStart(9),
  String(a.litHue).padStart(7),
  String(a.hueDrift).padStart(9),
].join(' ')

console.log('file'.padEnd(34), 'shadowLuma'.padStart(10), 'litLuma'.padStart(8),
            'lift'.padStart(6), 'shadowHue'.padStart(9), 'litHue'.padStart(7), 'hueDrift'.padStart(9))
console.log('-'.repeat(96))
console.log('REFERENCES')
const refs = REFS.map(analyse)
for (const a of refs) console.log(row(a))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const meanLift = mean(refs.map((r) => r.lift))
const meanShadowLuma = mean(refs.map((r) => r.shadowLuma))
const maxDrift = Math.max(...refs.map((r) => r.hueDrift))
// Allow 20% under the cohort mean before failing — references vary, but not 2x.
const floorShadowLuma = meanShadowLuma * 0.8
const floorLift = meanLift * 0.8

console.log('\nOUTPUT')
const outs = shots.map(analyse)
for (const a of outs) console.log(row(a))

console.log(`\ncohort '${COHORT}' mean: shadowLuma ${meanShadowLuma.toFixed(3)}, lift ${meanLift.toFixed(3)}, max hueDrift ${maxDrift}deg`)
console.log(`gate floors (mean*0.8): shadowLuma >= ${floorShadowLuma.toFixed(3)}, lift >= ${floorLift.toFixed(3)}`)
console.log('VERDICT (per shot):')
let failed = 0
for (const a of outs) {
  const p = []
  // Allow a little slack under the reference floor, but not a lot.
  if (a.shadowLuma < floorShadowLuma)
    p.push(`CRUSHED shadows (luma ${a.shadowLuma} vs floor ${floorShadowLuma.toFixed(3)}) — ART_BIBLE requires LIFTED, not just tinted`)
  if (a.lift < floorLift)
    p.push(`shadow/lit ratio ${a.lift} too harsh (floor ${floorLift.toFixed(3)})`)
  if (a.hueDrift > Math.max(maxDrift * 1.6, 40))
    p.push(`hue drifts ${a.hueDrift}deg shadow-to-lit (ref max ${maxDrift}) — material identity lost in shade`)
  if (p.length) failed++
  console.log('  ' + a.file.padEnd(30) + (p.length ? 'FAIL  ' + p.join('; ') : 'ok'))
}
console.log(failed ? `\n${failed} shot(s) failing shadow gate` : '\nall shots pass shadow gate')
process.exit(failed ? 1 : 0)
