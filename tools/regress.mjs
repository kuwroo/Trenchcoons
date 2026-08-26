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
const METRICS = [
  { key: 'meanSat',     from: 'palette',   dir: 'up' },
  { key: 'shadowLuma',  from: 'shadow',    dir: 'up' },
  { key: 'hueEntropy',  from: 'hue',       dir: 'up' },
  { key: 'flatPct',     from: 'structure', dir: 'down' },
  { key: 'specklePct',  from: 'structure', dir: 'down' },
  { key: 'detailErr',   from: 'structure', dir: 'down' },
]

const REF_DETAIL = 0.0688 // structure gate reference mean

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
      meanSat: pa.meanSat,
      shadowLuma: sh.shadowLuma,
      hueEntropy: hu.entropy,
      flatPct: st.flatPct,
      specklePct: st.specklePct,
      // Distance from the reference detail band centre — over and under are
      // both failures, so a single signed value would be misleading.
      detailErr: +Math.abs(st.medStd - REF_DETAIL).toFixed(4),
    }
  }
  return out
}

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
