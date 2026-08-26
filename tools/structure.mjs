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
  // ── gradient concentration + plateaus ──────────────────────────────────
  // What "painterly" actually means, numerically. The references are FLAT
  // MASSES of one value meeting at hard boundaries. medStd measures total
  // variance, which uniform airbrush wobble satisfies perfectly — which is why
  // three rounds of "add more detail" produced soft mush that passed.
  //
  //   measured, lower 28% of frame:   med grad   p99 grad   p99/med   plateau%
  //     cliffs-tohad                   0.0076     0.2597       34       27.1
  //     grasslands                     0.0196     0.2342       12        1.4
  //     water-lagoon                   0.0103     0.2492       24       23.8
  //     ours (near-noon)               0.0286     0.1605      5.6        0.7
  //
  // Median ABOVE every reference, p99 BELOW every reference: more wobble
  // everywhere, less contrast anywhere.
  //
  // The ratio is the key property: it CANNOT be gamed by adding wobble, because
  // raising the median lowers the ratio. Every previous one-sided metric could
  // be satisfied by turning some noise knob up.
  const yLow = Math.floor(H * 0.72)
  const grads = []
  let plateau = 0, plateauN = 0
  for (let y = yLow + 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const gx = lum[y * W + x + 1] - lum[y * W + x - 1]
      const gy = lum[(y + 1) * W + x] - lum[(y - 1) * W + x]
      grads.push(Math.hypot(gx, gy))
      // 5x5 neighbourhood flat to 0.010 luma = a plateau pixel
      let mn = 1, mx = 0
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const v = lum[(y + j) * W + x + i]
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      plateauN++
      if (mx - mn < 0.010) plateau++
    }
  }
  grads.sort((a, b) => a - b)
  const gq = (p) => grads[Math.floor(grads.length * p)] ?? 0
  const medGrad = gq(0.5), p99Grad = gq(0.99)

  // ── multi-scale coherence ──────────────────────────────────────────────
  // Local variance alone cannot tell painterly brushwork from noise: isotropic
  // high-frequency noise MAXIMISES it. Round 4 exploited exactly that and
  // shipped a writhing worm pattern that scored above the reference.
  //
  // The discriminator is scale. Real painted detail is coherent across scales
  // (strokes have direction and length, terrain has form under its texture),
  // so it survives a 4x box downsample. Fine noise averages away to nothing.
  const W4 = Math.floor(W / 4), H4 = Math.floor(H / 4)
  const lum4 = new Float32Array(W4 * H4)
  for (let y = 0; y < H4; y++) {
    for (let x = 0; x < W4; x++) {
      let a = 0
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) a += lum[(y * 4 + dy) * W + x * 4 + dx]
      lum4[y * W4 + x] = a / 16
    }
  }
  const y04 = Math.floor(H4 * 0.4)
  const stds4 = []
  const T4 = Math.max(4, Math.floor(TILE / 4))
  for (let ty = y04; ty + T4 <= H4; ty += T4) {
    for (let tx = 0; tx + T4 <= W4; tx += T4) {
      let a = 0, a2 = 0, n = 0
      for (let y = ty; y < ty + T4; y++) for (let x = tx; x < tx + T4; x++) {
        const v = lum4[y * W4 + x]; a += v; a2 += v * v; n++
      }
      const m = a / n
      stds4.push(Math.sqrt(Math.max(0, a2 / n - m * m)))
    }
  }
  stds4.sort((a, b) => a - b)
  const med4 = stds4[Math.floor(stds4.length * 0.5)] ?? 0

  // ── speckle ────────────────────────────────────────────────────────────
  // Isolated pixels far from ALL four neighbours: NaN spray, severe aliasing,
  // or dithered edges. Round 4 produced visible dotted lines along every ridge.
  let speckle = 0, considered = 0
  for (let y = y0 + 1; y < H - 1; y += 2) {
    for (let x = 1; x < W - 1; x += 2) {
      const c = lum[y * W + x]
      const n1 = lum[(y - 1) * W + x], n2 = lum[(y + 1) * W + x]
      const n3 = lum[y * W + x - 1], n4 = lum[y * W + x + 1]
      const mn = Math.min(n1, n2, n3, n4), mx = Math.max(n1, n2, n3, n4)
      considered++
      if (c < mn - 0.14 || c > mx + 0.14) speckle++
    }
  }

  stds.sort((a, b) => a - b)
  const q = (p) => stds[Math.floor(stds.length * p)] ?? 0
  const flat = stds.filter((s) => s < 0.012).length / Math.max(stds.length, 1)

  // ── edge density ───────────────────────────────────────────────────────
  // Per-tile variance cannot tell a 40 px soft blob from a brush mark: a 48 px
  // tile's standard deviation is maximised by soft lobes just as well as by
  // paint, and round 5 went straight through that hole — medStd landed inside
  // the reference band while the frames carried 4-7x fewer real edges than the
  // references and read as airbrushed camouflage.
  //
  // What separates them is where the variation SITS. Painted detail is mostly
  // the boundaries of discrete forms, so its gradient histogram has a heavy
  // tail; a smooth noise field spreads the same variance thinly and has none.
  // Measured over the same lower 60%, central differences on luma:
  //
  //   refs   >0.06: 7.0-16.1%   >0.12: 2.3-9.9%
  //   round5 >0.06: 1.3-5.5%    >0.12: 0.27-2.1%
  //
  // Reported, NOT gated. It has not been through the "run it against refs/
  // first" discipline as a threshold — the numbers above are one pass over five
  // images — and CLAUDE.md is explicit that a gate needs both a floor and a
  // ceiling before it can be trusted. This column exists so the next round can
  // see the hole rather than fall through it.
  let e06 = 0, e12 = 0, eN = 0
  for (let y = y0 + 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx = lum[y * W + x + 1] - lum[y * W + x - 1]
      const gy = lum[(y + 1) * W + x] - lum[(y - 1) * W + x]
      const g = Math.sqrt(gx * gx + gy * gy)
      eN++
      if (g > 0.06) e06++
      if (g > 0.12) e12++
    }
  }

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
    // Fraction of detail that survives a 4x downsample. Low = fine noise.
    coherence: +(med4 / Math.max(q(0.5), 1e-6)).toFixed(3),
    gradRatio: +(p99Grad / Math.max(medGrad, 1e-6)).toFixed(1),
    plateauPct: +((plateau / Math.max(plateauN, 1)) * 100).toFixed(1),
    specklePct: +((speckle / Math.max(considered, 1)) * 100).toFixed(2),
    flatPct: +(flat * 100).toFixed(1),
    // Fraction of lower-60% pixels carrying a real luma edge. Diagnostic only.
    edge06Pct: +((e06 / Math.max(eN, 1)) * 100).toFixed(2),
    edge12Pct: +((e12 / Math.max(eN, 1)) * 100).toFixed(2),
    stepRatio: total > 500 ? +(repeats / total).toFixed(3) : 0,
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
  String(a.gradRatio).padStart(9),
  String(a.plateauPct).padStart(9),
  String(a.specklePct).padStart(9),
  String(a.edge12Pct).padStart(8),
].join(' ')

console.log('file'.padEnd(34), 'medStd'.padStart(8), 'p10Std'.padStart(8),
            'flat%'.padStart(8), 'gradRat'.padStart(9), 'plateau%'.padStart(9),
            'speckle%'.padStart(9), 'edg.12%'.padStart(8))
console.log('-'.repeat(94))
console.log('REFERENCES')
const refs = REFS.map(analyse)
for (const a of refs) console.log(row(a))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const refMedStd = mean(refs.map((r) => r.medStd))
const refFlat = mean(refs.map((r) => r.flatPct))
const refCoh = mean(refs.map((r) => r.coherence))
const refGradRatioMin = Math.min(...refs.map((r) => r.gradRatio))
const refPlateauMin = Math.min(...refs.map((r) => r.plateauPct))
const refSpeck = mean(refs.map((r) => r.specklePct))

console.log('\nOUTPUT')
const outs = shots.map(analyse)
for (const a of outs) console.log(row(a))

const refE06 = mean(refs.map((r) => r.edge06Pct))
const refE12 = mean(refs.map((r) => r.edge12Pct))

console.log(`\nreference mean: medStd ${refMedStd.toFixed(4)}, flat% ${refFlat.toFixed(1)}, speckle% ${refSpeck.toFixed(2)}`)
console.log(`reference MINIMUMS: gradRatio ${refGradRatioMin.toFixed(1)}, plateau% ${refPlateauMin.toFixed(1)}`)
console.log(`reference edge density (DIAGNOSTIC, not gated): >0.06 ${refE06.toFixed(2)}%, >0.12 ${refE12.toFixed(2)}%`)
console.log('VERDICT (per shot):')
let failed = 0
for (const a of outs) {
  const p = []
  if (a.medStd < refMedStd * 0.45)
    p.push(`FORMLESS — median tile detail ${a.medStd} vs ref ${refMedStd.toFixed(4)}`)
  if (a.flatPct > Math.max(refFlat * 2.5, 12))
    p.push(`${a.flatPct}% of foreground tiles are dead flat (ref ${refFlat.toFixed(1)}%)`)
  // A CEILING, not just a floor. The floor alone was gamed: round 4 shipped a
  // writhing high-frequency worm pattern that scored 0.09-0.14 against a
  // reference band of 0.056-0.080 and passed, while looking far worse than the
  // smooth version it replaced. Detail has to land IN the reference band.
  //
  // Three attempts at detecting "noise rather than brushwork" directly all
  // failed to separate our output from the references: 4x-downsample coherence
  // (ours 0.87-0.95 vs refs 0.75-0.94), near/far depth gradient (ours 1.34-1.80
  // vs refs 1.18-3.91), and edge coherence. Excess magnitude is the signal that
  // actually works, so that is what is gated.
  if (a.medStd > refMedStd * 1.35)
    p.push(`OVER-DETAILED — tile detail ${a.medStd} is ${(a.medStd / refMedStd).toFixed(1)}x the reference mean ${refMedStd.toFixed(4)} (band 0.056-0.080); reads as noise, not brushwork`)
  // Floors from the least-painterly reference, with slack. Gradient
  // concentration is the anti-gaming one: uniform wobble raises the median and
  // therefore LOWERS the ratio.
  if (a.gradRatio < refGradRatioMin * 0.8)
    p.push(`AIRBRUSHED — gradient concentration ${a.gradRatio} vs reference floor ${refGradRatioMin.toFixed(1)}; soft gradients everywhere instead of flat masses meeting at hard edges`)
  if (a.plateauPct < refPlateauMin * 0.5)
    p.push(`NO FLAT MASSES — ${a.plateauPct}% plateau pixels vs reference floor ${refPlateauMin.toFixed(1)}%`)
  if (a.specklePct > Math.max(refSpeck * 4, 0.09))
    p.push(`SPECKLE/ALIASING — ${a.specklePct}% isolated outlier pixels (ref ${refSpeck.toFixed(2)}%)`)
  if (p.length) failed++
  console.log('  ' + a.file.padEnd(30) + (p.length ? 'FAIL  ' + p.join('; ') : 'ok'))
}
console.log(failed ? `\n${failed} shot(s) failing structure gate` : '\nall shots pass structure gate')
process.exit(failed ? 1 : 0)

}
