// Pairwise distinctness gate.
//
// Per-image metrics (tools/palette.mjs) structurally cannot catch a whole class
// of failure: two states that are each individually fine but identical to each
// other. The harsh critic found exactly this in round 1 — sunDirection() mapped
// tod 0.25 and 0.75 to the same solar elevation with only a mirrored azimuth,
// so sunrise and sunset came out 9.73/255 apart. Every per-shot check passed.
//
// Usage: node tools/distinct.mjs [groupName]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const TMP = '/tmp/trench-distinct'
fs.mkdirSync(TMP, { recursive: true })

function loadPng(file) {
  let p = file
  if (!file.toLowerCase().endsWith('.png')) {
    p = path.join(TMP, path.basename(file).replace(/\.\w+$/, '') + '.png')
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', p], { stdio: 'ignore' })
  }
  return PNG.sync.read(fs.readFileSync(p))
}

/** Mean absolute per-channel difference, 0..255. Downsamples for speed. */
function meanDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity
  let sum = 0, n = 0
  const step = 4 * 4 // every 4th pixel
  for (let i = 0; i < a.data.length; i += step) {
    sum += Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2])
    n += 3
  }
  return sum / n
}

// Compare only pairs that differ in EXACTLY ONE parameter. Comparing shots
// that differ in camera position tells you nothing about whether time of day
// works, and produces false positives — two dawn shots from different vantage
// points are supposed to look similar.
//
// Shot definitions carry their own params, so the grouping is derived rather
// than guessed from filenames.
const { SHOTS } = await import('./shots.mjs')

/** Split a shot's query string into a param map. */
function params(q) {
  return Object.fromEntries(new URLSearchParams(q).entries())
}

/** Key identifying everything EXCEPT the axis under test. */
function keyExcept(p, axis) {
  return Object.entries(p).filter(([k]) => k !== axis)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('&')
}

const AXES = [
  { axis: 'time', min: 18,
    why: 'Time of day must actually change the image (ART_BIBLE §8). Sunrise '
       + 'and dusk are trivially collapsed by a sun model that only mirrors '
       + 'azimuth — round 1 shipped exactly that bug at 9.73/255.' },
  { axis: 'weather', min: 14,
    why: 'Weather must visibly change the grade and atmosphere (ART_BIBLE §9).' },
  { axis: 'biome', min: 22,
    why: 'Biomes must be visually distinct, not a recoloured same-place.' },
]

let failed = 0
const want = process.argv[2]

for (const { axis, min, why } of AXES) {
  if (want && want !== axis) continue

  // Bucket shots by everything-but-this-axis; only buckets with >1 member
  // give a valid comparison along it.
  const buckets = new Map()
  for (const s of SHOTS) {
    const p = params(s.q)
    if (!(axis in p)) continue
    const k = keyExcept(p, axis)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push({ name: s.name, val: p[axis] })
  }
  const usable = [...buckets.entries()].filter(([, v]) => v.length > 1)
  if (!usable.length) {
    console.log(`[${axis}] skipped — no two shots differ in ${axis} alone`)
    continue
  }

  console.log(`\n[${axis}] ${why}`)
  console.log(`  threshold: mean channel diff >= ${min}\n`)

  for (const [, members] of usable) {
    const rows = []
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j]
        const fa = `shots/${a.name}.png`, fb = `shots/${b.name}.png`
        if (!fs.existsSync(fa) || !fs.existsSync(fb)) continue
        const d = meanDiff(loadPng(fa), loadPng(fb))
        rows.push({ a, b, d })
      }
    }
    rows.sort((x, y) => x.d - y.d)
    for (const r of rows) {
      const bad = r.d < min
      if (bad) failed++
      console.log(`  ${bad ? 'FAIL' : 'ok  '} ${String(r.d.toFixed(2)).padStart(7)}  `
        + `${axis}=${r.a.val} vs ${axis}=${r.b.val}  (${r.a.name} / ${r.b.name})`
        + (bad ? '   <-- COLLAPSED' : ''))
    }
  }
}

console.log(failed ? `\n${failed} collapsed pair(s)` : '\nall compared pairs distinct')
process.exit(failed ? 1 : 0)
