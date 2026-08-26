// Regression ledger.
//
// The gauntlet was oscillating, not converging: scores across four rounds went
// 4.2 -> 4.3 -> 4.5 -> 2.8 while every round genuinely fixed something. The
// cause is that the gates only ask "is this value in the reference band?" and
// never "is this worse than we already had?" In a coupled system — sky feeds
// ambient feeds material feeds post — that lets each round trade one frame's
// quality for another's indefinitely.
//
// This records the BEST value ever seen per shot per metric, and fails any run
// that regresses materially against it. Progress becomes ratchet-only.
//
//   node tools/regress.mjs            check current shots against the ledger
//   node tools/regress.mjs --accept   fold current values in as the new best
import fs from 'node:fs'
import * as palette from './palette.mjs'
import * as shadow from './shadow.mjs'
import * as structure from './structure.mjs'
import * as hue from './hue.mjs'

const LEDGER = 'shots/.best.json'

// Metric name -> how to score it. `dir` is which way is better; `band` metrics
// are best when closest to the reference mean, so distance-to-target is scored.
// Two of these used to be `dir: 'up'` on the RAW value, and both were the exact
// failure mode CLAUDE.md warns about: "Every gate needs a floor AND a ceiling.
// Three separate one-sided metrics were gamed during M1: shadowSat rewarded navy
// shadows, vRange rewarded crushed darks, medStd rewarded high-frequency noise."
//
//   shadowLuma up-only ratchets the DARKEST FIFTH of every frame brighter for
//   ever. It is the metric that a pedestal maximises, so the ledger was actively
//   locking in the "no darks anywhere" state that round 6 was rejected for —
//   atmos-clouds-noon's best-ever 0.527 is a frame with literally zero pixels
//   below HSL lightness 0.35, and no correct render can ever beat it.
//
//   meanSat up-only ratchets saturation with no ceiling, and the references top
//   out at 0.767 with a mean of 0.595. atmos-sunrise's best-ever 0.730 was the
//   fluorescent-magenta round.
//
// Both are now scored the way `detailErr` already was: distance from the
// reference mean, ratcheted DOWN. Same discipline, two-sided. The reference
// means are measured from refs/ on every run rather than hardcoded.
//
// The other half of the same correction: NO METRIC RATCHETS PAST THE REFERENCE
// BAND. Every error term below is measured as distance OUTSIDE the band the
// references occupy, not distance from a point, so a shot that is already
// inside the band scores exactly 0 and cannot be pushed further by the ledger.
// Without that, `flatPct` down-only was ratcheting the number of dead-flat
// tiles toward zero while the references average 2.7% and the detail critique's
// headline finding was that our surfaces have NO plateaus — the ledger was
// enforcing the defect.
const METRICS = [
  { key: 'satErr',        from: 'palette',   dir: 'down' },
  { key: 'shadowLumaErr', from: 'shadow',    dir: 'down' },
  { key: 'hueEntropy',    from: 'hue',       dir: 'up' },
  { key: 'flatErr',       from: 'structure', dir: 'down' },
  { key: 'specklePct',    from: 'structure', dir: 'down' },
  { key: 'detailErr',     from: 'structure', dir: 'down' },
]

/** Distance outside [lo, hi]; zero anywhere inside it. */
const outside = (v, lo, hi) => +Math.max(0, Math.max(lo - v, v - hi)).toFixed(4)

// Measured off refs/ at import time, so these cannot drift away from the images
// the gates are calibrated on.
const PALETTE_REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/character/raccoon-artstyle-capycastaway.jpg',
]
const SHADOW_REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/painterly/desert-hazy.jpeg',
]
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const STRUCT_REFS = [
  'refs/painterly/cliffs-tohad.jpg',
  'refs/capycastaway/water-lagoon.webp',
  'refs/genshin/grasslands.jpg',
  'refs/painterly/desert-hazy.jpeg',
  'refs/snow/snow.avif',
]
const span = (xs) => [Math.min(...xs), Math.max(...xs)]
const satS = PALETTE_REFS.filter(fs.existsSync).map((f) => palette.analyse(f).meanSat)
const shadS = SHADOW_REFS.filter(fs.existsSync).map((f) => shadow.analyse(f).shadowLuma)
const structS = STRUCT_REFS.filter(fs.existsSync).map((f) => structure.analyse(f))
const SAT_BAND = span(satS)
const SHADOW_BAND = span(shadS)
const DETAIL_BAND = span(structS.map((r) => r.medStd))
const FLAT_BAND = span(structS.map((r) => r.flatPct))
const REF_SPECKLE = mean(structS.map((r) => r.specklePct))

function collect() {
  const shots = fs.existsSync('shots')
    ? fs.readdirSync('shots').filter((f) => f.endsWith('.png')).sort()
    : []
  const out = {}
  for (const f of shots) {
    const p = 'shots/' + f
    const pa = palette.analyse(p)
    const sh = shadow.analyse(p)
    const st = structure.analyse(p)
    const hu = hue.analyse(p)
    out[f] = {
      satErr: outside(pa.meanSat, SAT_BAND[0], SAT_BAND[1]),
      shadowLumaErr: outside(sh.shadowLuma, SHADOW_BAND[0], SHADOW_BAND[1]),
      hueEntropy: hu.entropy,
      flatErr: outside(st.flatPct, FLAT_BAND[0], FLAT_BAND[1]),
      specklePct: +Math.max(0, st.specklePct - REF_SPECKLE).toFixed(4),
      // Distance OUTSIDE the reference detail band — over and under are both
      // failures, so a single signed value would be misleading.
      detailErr: outside(st.medStd, DETAIL_BAND[0], DETAIL_BAND[1]),
    }
  }
  return out
}

const fmt = (b) => `${b[0].toFixed(3)}-${b[1].toFixed(3)}`
console.log(`reference bands: meanSat ${fmt(SAT_BAND)}  shadowLuma ${fmt(SHADOW_BAND)}`
  + `  medStd ${fmt(DETAIL_BAND)}  flat% ${fmt(FLAT_BAND)}  speckle% ${REF_SPECKLE.toFixed(3)}`)
console.log('(all *Err metrics are distance OUTSIDE the band; inside scores 0)')
const cur = collect()
const accept = process.argv.includes('--accept')
const prev = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {}

if (accept) {
  const next = { ...prev }
  for (const [shot, vals] of Object.entries(cur)) {
    next[shot] = next[shot] ?? {}
    for (const m of METRICS) {
      const v = vals[m.key], b = next[shot][m.key]
      const better = b === undefined || (m.dir === 'up' ? v > b : v < b)
      if (better) next[shot][m.key] = v
    }
  }
  fs.writeFileSync(LEDGER, JSON.stringify(next, null, 1) + '\n')
  console.log(`ledger updated: ${Object.keys(next).length} shots`)
  process.exit(0)
}

if (!Object.keys(prev).length) {
  console.log('no ledger yet — run `node tools/regress.mjs --accept` to seed it')
  process.exit(0)
}

// 12% slack: metrics jitter run to run, and a hard ratchet would block all work.
const SLACK = 0.12
let regressions = 0

console.log('shot'.padEnd(30), 'metric'.padEnd(12), 'best'.padStart(8), 'now'.padStart(8))
console.log('-'.repeat(70))
for (const [shot, vals] of Object.entries(cur)) {
  const b = prev[shot]
  if (!b) continue
  for (const m of METRICS) {
    const best = b[m.key], now = vals[m.key]
    if (best === undefined || now === undefined) continue
    const worse = m.dir === 'up'
      ? now < best * (1 - SLACK)
      : now > best * (1 + SLACK) + 0.005
    if (worse) {
      regressions++
      console.log(shot.slice(0, 29).padEnd(30), m.key.padEnd(12),
                  String(best).padStart(8), String(now).padStart(8), ' REGRESSED')
    }
  }
}

console.log(regressions
  ? `\n${regressions} regression(s) against best-ever. Fix these before adding anything.`
  : '\nno regressions against best-ever')
process.exit(regressions ? 1 : 0)
