// Hue-diversity gate.
//
// A frame can pass saturation, shadow-lift and structure while being a
// single-hue wash. Round 3's dusk frames did exactly that: with direct light
// near zero at low sun, `albedo * ambient` repaints every surface in the sky's
// hue, so green grass, tan rock and blue water all converge on periwinkle.
// Mean saturation stays healthy; material identity is gone.
//
// References always carry several distinct hue families at once — Tohad has
// lime grass, turquoise sea, pink cloud and cream cliff in one frame.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-hue'
fs.mkdirSync(TMP, { recursive: true })

function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

const BINS = 36 // 10 degrees per bin

export function analyse(file) {
  const png = loadPng(file)
  const hist = new Float64Array(BINS)
  let weight = 0
  for (let i = 0; i < png.data.length; i += 16) {
    const r = png.data[i] / 255, g = png.data[i + 1] / 255, b = png.data[i + 2] / 255
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
    if (d < 0.06) continue // achromatic pixels carry no hue information
    let h
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0))
    else if (mx === g) h = ((b - r) / d + 2)
    else h = ((r - g) / d + 4)
    h = ((h * 60) % 360 + 360) % 360
    // Weight by chroma so a faint tint does not count as a hue family.
    const w = d
    hist[Math.floor(h / (360 / BINS)) % BINS] += w
    weight += w
  }
  if (weight === 0) return { file: path.basename(file), entropy: 0, families: 0, dominant: 100 }

  let entropy = 0, dominant = 0
  const shares = []
  for (let i = 0; i < BINS; i++) {
    const p = hist[i] / weight
    shares.push(p)
    if (p > 0) entropy -= p * Math.log2(p)
    if (p > dominant) dominant = p
  }
  // Count separated hue families: bins holding >=4% of total chroma, merged
  // when adjacent so one broad family is not counted several times.
  const hot = shares.map((p) => p >= 0.04)
  let families = 0
  for (let i = 0; i < BINS; i++) {
    if (hot[i] && !hot[(i - 1 + BINS) % BINS]) families++
  }
  if (families === 0 && hot.some(Boolean)) families = 1

  return {
    file: path.basename(file),
    entropy: +entropy.toFixed(2),
    families,
    dominant: +(dominant * 100).toFixed(1),
  }
}

// Only run the CLI when invoked directly. These modules are imported by
// tools/regress.mjs, and unguarded top-level output would fire on import.
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`
if (IS_MAIN) {

// Snow is legitimately monochrome — refs/snow scores 1 hue family and entropy
// 1.84. Including it in the floor cohort would licence a periwinkle wash
// everywhere; gating on it would fail the reference itself. So it sets the
// floor only for shots that are actually snow.
const POLYCHROME_REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/character/raccoon-artstyle-capycastaway.jpg',
  'refs/painterly/desert-hazy.jpeg',
].filter(fs.existsSync)
const MONOCHROME_REFS = ['refs/snow/snow.avif'].filter(fs.existsSync)
const REFS = [...POLYCHROME_REFS, ...MONOCHROME_REFS]

/** Shots of an inherently monochrome biome are held to the snow floor. */
const isMonochromeBiome = (f) => /snow|alpine|blizzard|whiteout/i.test(f)

const shots = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.existsSync('shots') ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
  : []

const row = (a) => [
  a.file.slice(0, 34).padEnd(34),
  String(a.entropy).padStart(8),
  String(a.families).padStart(9),
  String(a.dominant).padStart(10),
].join(' ')

console.log('file'.padEnd(34), 'entropy'.padStart(8), 'families'.padStart(9), 'dominant%'.padStart(10))
console.log('-'.repeat(66))
console.log('REFERENCES')
const refs = REFS.map(analyse)
for (const a of refs) console.log(row(a))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const poly = refs.filter((r) => POLYCHROME_REFS.some((p) => p.endsWith(r.file)))
const mono = refs.filter((r) => MONOCHROME_REFS.some((p) => p.endsWith(r.file)))
const refEnt = mean(poly.map((r) => r.entropy))
const refDom = mean(poly.map((r) => r.dominant))
// Floor from the LEAST diverse legitimate polychrome reference, with slack.
const entFloor = Math.min(...poly.map((r) => r.entropy)) * 0.75
const monoEntFloor = mono.length ? Math.min(...mono.map((r) => r.entropy)) * 0.75 : 1.0

console.log('\nOUTPUT')
const outs = shots.map(analyse)
for (const a of outs) console.log(row(a))

console.log(`\npolychrome refs: mean entropy ${refEnt.toFixed(2)}, mean dominant ${refDom.toFixed(1)}%`)
console.log(`floors: entropy >= ${entFloor.toFixed(2)} (polychrome), >= ${monoEntFloor.toFixed(2)} (snow/alpine shots)`)
console.log('VERDICT (per shot):')
let failed = 0
for (const a of outs) {
  const p = []
  const floor = isMonochromeBiome(a.file) ? monoEntFloor : entFloor
  if (a.entropy < floor)
    p.push(`MONOCHROME WASH — hue entropy ${a.entropy} vs floor ${floor.toFixed(2)}`)
  if (a.dominant > Math.max(refDom * 1.8, 60))
    p.push(`${a.dominant}% of all chroma in one 10deg bin (ref ${refDom.toFixed(1)}%) — material identity lost`)
  // NOTE: a raw "families < 2" rule was tried and dropped — it failed
  // refs/snow, and cliffs-tohad carries only 2. Family count is too blunt to
  // gate on; entropy captures the same idea continuously.
  if (p.length) failed++
  console.log('  ' + a.file.padEnd(30) + (p.length ? 'FAIL  ' + p.join('; ') : 'ok'))
}
console.log(failed ? `\n${failed} shot(s) failing hue gate` : '\nall shots pass hue gate')
process.exit(failed ? 1 : 0)

}
