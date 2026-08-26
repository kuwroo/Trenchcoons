// Local-structure gate.
//
// palette/shadow/distinct all measure GLOBAL statistics, which is why round 2
// shipped two failures they could not see: low-sun frames whose entire
// foreground fell on one ramp stop (a "formless slab" with correct mean
// saturation and correct mean shadow luma), and a staircased shadow terminator
// from a 1.95 m/texel shadow map.
//
// A frame can be statistically perfect and visually broken. This measures
// whether local detail actually exists, tile by tile.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-structure'
fs.mkdirSync(TMP, { recursive: true })

function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

const TILE = 48

export function analyse(file) {
  const png = loadPng(file)
  const { width: W, height: H, data } = png
  const lum = new Float32Array(W * H)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
  }

  // Per-tile standard deviation of luma. Restricted to the lower 60% of the
  // frame: sky is legitimately smooth and would mask a dead foreground.
  const y0 = Math.floor(H * 0.4)
  const stds = []
  for (let ty = y0; ty + TILE <= H; ty += TILE) {
    for (let tx = 0; tx + TILE <= W; tx += TILE) {
      let s = 0, s2 = 0, n = 0
      for (let y = ty; y < ty + TILE; y += 2) {
        for (let x = tx; x + 1 < tx + TILE; x += 2) {
          const v = lum[y * W + x]
          s += v; s2 += v * v; n++
        }
      }
      const mean = s / n
      stds.push(Math.sqrt(Math.max(0, s2 / n - mean * mean)))
    }
  }
  stds.sort((a, b) => a - b)
  const q = (p) => stds[Math.floor(stds.length * p)] ?? 0
  const flat = stds.filter((s) => s < 0.012).length / Math.max(stds.length, 1)

  // Edge coherence: fraction of edge pixels that repeat at the same x on the
  // row above. NOT a staircase detector — that was the intent, but references
  // score HIGHER (0.58-0.65) than our output, because coherent edges are what
  // detailed imagery is made of. It is confounded with overall detail and is
  // reported for information only, deliberately NOT gated on.
  const edgeRows = []
  for (let y = y0 + 1; y < H - 1; y++) {
    const row = []
    for (let x = 2; x < W - 2; x++) {
      if (Math.abs(lum[y * W + x + 1] - lum[y * W + x - 1]) > 0.05) row.push(x)
    }
    edgeRows.push(new Set(row))
  }
  let repeats = 0, total = 0
  for (let i = 1; i < edgeRows.length; i++) {
    const cur = edgeRows[i], prev = edgeRows[i - 1]
    for (const x of cur) { total++; if (prev.has(x)) repeats++ }
  }

  return {
    file: path.basename(file),
    medStd: +q(0.5).toFixed(4),
    p10Std: +q(0.1).toFixed(4),
    flatPct: +(flat * 100).toFixed(1),
    stepRatio: total > 500 ? +(repeats / total).toFixed(3) : 0,
  }
}

const REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/painterly/desert-hazy.jpeg',
  'refs/snow/snow.avif',
].filter(fs.existsSync)

const shots = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.existsSync('shots') ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).map((f) => 'shots/' + f)
  : []

const row = (a) => [
  a.file.slice(0, 34).padEnd(34),
  String(a.medStd).padStart(8),
  String(a.p10Std).padStart(8),
  String(a.flatPct).padStart(8),
  String(a.stepRatio).padStart(10),
].join(' ')

console.log('file'.padEnd(34), 'medStd'.padStart(8), 'p10Std'.padStart(8),
            'flat%'.padStart(8), 'edgeCoh'.padStart(10))
console.log('-'.repeat(76))
console.log('REFERENCES')
const refs = REFS.map(analyse)
for (const a of refs) console.log(row(a))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const refMedStd = mean(refs.map((r) => r.medStd))
const refFlat = mean(refs.map((r) => r.flatPct))
const refStep = mean(refs.map((r) => r.stepRatio))

console.log('\nOUTPUT')
const outs = shots.map(analyse)
for (const a of outs) console.log(row(a))

console.log(`\nreference mean: medStd ${refMedStd.toFixed(4)}, flat% ${refFlat.toFixed(1)}, stepRatio ${refStep.toFixed(3)}`)
console.log('VERDICT (per shot):')
let failed = 0
for (const a of outs) {
  const p = []
  if (a.medStd < refMedStd * 0.45)
    p.push(`FORMLESS — median tile detail ${a.medStd} vs ref ${refMedStd.toFixed(4)}`)
  if (a.flatPct > Math.max(refFlat * 2.5, 12))
    p.push(`${a.flatPct}% of foreground tiles are dead flat (ref ${refFlat.toFixed(1)}%)`)
  if (p.length) failed++
  console.log('  ' + a.file.padEnd(30) + (p.length ? 'FAIL  ' + p.join('; ') : 'ok'))
}
console.log(failed ? `\n${failed} shot(s) failing structure gate` : '\nall shots pass structure gate')
process.exit(failed ? 1 : 0)
