// Asset Forge harness: budget report + contact sheets for the scatter library.
//
// DELIBERATELY NOT PART OF `npm run gate`. CLAUDE.md requires every gate to be
// a subject-vs-control RATIO — "a one-sided metric is an invitation to optimise
// the proxy instead of the goal" — and a triangle budget is an absolute by
// nature. It is a BUILD BUDGET, checked here on its own, and it moves nothing
// in the visual gate suite.
//
//   node tools/assets.mjs             budget + every contact sheet
//   node tools/assets.mjs --report    budget only, no captures
//
// The captures are the point. The scatter library is not in the game scene yet
// (placement belongs to the world team), so `npm run shots` cannot see it, and
// "it compiles" is not the bar this project sets for visual work.
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WEBGPU_ARGS } from './shots.mjs'

const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:4173'
// A SUBDIRECTORY of shots/, and that is load-bearing. Every gate in tools/
// enumerates `readdirSync('shots').filter(f => f.endsWith('.png'))`, so anything
// written next to the game captures gets graded by the palette, shadow,
// structure, hue and regress gates. These are asset contact sheets — one flat
// ground plane and a handful of props — and they are not the compositions those
// gates were calibrated on; dropped into shots/ they failed six of them
// instantly and would have buried a real regression in noise. A directory name
// does not end in .png, so this is invisible to all of them.
const OUT = 'shots/forge'
const W = 1600
const H = 900

const ROCK = 'rock-pebble,rock-slab,rock-small,rock-medium,boulder-large'
const CLIFF = 'outcrop-shelf,outcrop-step,cliff-block'
const TREES = 'conifer-young,conifer-tall'
const VEG = 'grass-tuft,grass-cluster,bush-round,shrub-broadleaf'
const PROPS = 'log-fallen,stump-broken,roots-exposed'
const HERO = 'rock-slab,rock-medium,boulder-large,outcrop-shelf,conifer-tall,shrub-broadleaf'

export const SHEETS = [
  // Hour 0.62, not the 0.36 hero hour, and for the reason tools/shots.mjs gives
  // for the car captures: at 0.36 the sun is in FRONT of a camera looking down
  // -Z, so every asset on the sheet is its own silhouette and none of the form
  // reads. The first round of these was captured at 0.36 and the conifers came
  // back as black cutouts — which looked exactly like a shading bug and was not
  // one. 0.62 puts the key behind the camera.
  { name: 'forge-rock',      q: `ids=${ROCK}&row=5&time=0.62` },
  // Raised camera: at the default elevation a nineteen-metre block is taller
  // than the eye and the sheet shows nothing but its vertical faces.
  { name: 'forge-cliff',     q: `ids=${CLIFF}&row=3&time=0.62&pitch=0.5` },
  { name: 'forge-trees',     q: `ids=${TREES}&row=2&time=0.62&dist=0.85&pitch=0.34` },
  { name: 'forge-veg',       q: `ids=${VEG}&row=4&time=0.62` },
  { name: 'forge-props',     q: `ids=${PROPS}&row=3&time=0.62` },
  // Variant 1: the jitter has to produce a visibly different asset, not the
  // same one nudged.
  { name: 'forge-variants',  q: `ids=${ROCK}&row=5&time=0.62&variant=1` },
  // The ladder. Same framing, three rungs plus the impostor: a rung that
  // changes the SILHOUETTE is a rung that will pop.
  { name: 'forge-lod0',      q: `ids=${HERO}&row=6&time=0.62&lod=0` },
  { name: 'forge-lod1',      q: `ids=${HERO}&row=6&time=0.62&lod=1` },
  { name: 'forge-lod2',      q: `ids=${HERO}&row=6&time=0.62&lod=2` },
  { name: 'forge-impostor',  q: `ids=${HERO}&row=6&time=0.62&lod=imp` },
  // The world team's hard dependency, drawn.
  { name: 'forge-collider',  q: `ids=${HERO}&row=6&time=0.62&collider=1` },
  // Low sun: flat planes are only sculptural if they take different values, and
  // a raking light is where that either works or does not.
  { name: 'forge-raking',    q: `ids=${ROCK}&row=5&time=0.70` },
  // And the opposite check — the 0.36 hero hour with the sun in front, where
  // all that survives is outline. ART_BIBLE 2: "every asset reads as a clear
  // silhouette at its LOD2 distance."
  { name: 'forge-backlit',   q: `ids=${HERO}&row=6&time=0.36` },
]

function table(budget) {
  const head = ['id', 'var', 'generator', 'parts', 'lod0', 'lodN', 'imp', 'batch', 'foot', 'high', 'shapes']
  const rows = budget.rows.map((r) => [
    r.id, String(r.variant), r.generator, String(r.parts), String(r.lod0), String(r.lodN),
    String(r.impostor), String(r.batches), r.footprint.toFixed(2), r.height.toFixed(2),
    r.solid ? String(r.colliderShapes) : '-',
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => i === 0 || i === 2 ? c.padEnd(w[i]) : c.padStart(w[i])).join('  ')
  console.log(line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const r of rows) console.log(line(r))
}

async function main() {
  const reportOnly = process.argv.includes('--report')
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  let failed = 0
  await page.goto(`${BASE}/forge.html?shot=1&${SHEETS[0].q}`, { waitUntil: 'load', timeout: 30_000 })
  await page.evaluate(() => window.__ready ?? Promise.reject(new Error('__ready missing')))
  const budget = await page.evaluate(() => window.__forge?.budget ?? null)
  if (!budget) {
    console.log('FAIL: forge page exposed no budget')
    await browser.close()
    process.exit(1)
  }
  table(budget)
  console.log(
    `\n${budget.defs} defs, ${budget.assets} baked variants, ${budget.batches} batches, ` +
    `worst-case ${budget.worstCaseDraws} draws (scene + 4 shadow cascades)`,
  )
  for (const p of budget.problems) {
    console.log(`  BUDGET ${p}`)
    failed++
  }

  if (!reportOnly) {
    console.log('')
    for (const s of SHEETS) {
      const url = `${BASE}/forge.html?shot=1&${s.q}`
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
        await page.evaluate(() => window.__ready ?? Promise.reject(new Error('__ready missing')))
        await page.screenshot({ path: path.join(OUT, `${s.name}.png`) })
        console.log(`  ok   ${s.name.padEnd(18)} ${url}`)
      } catch (e) {
        failed++
        console.log(`  FAIL ${s.name.padEnd(18)} ${String(e).split('\n')[0]}`)
      }
    }
  }

  if (errors.length) {
    console.log('\npage errors:')
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e)
    failed += errors.length
  }
  await browser.close()
  console.log(failed ? `\n${failed} problem(s)` : '\nassets ok')
  process.exit(failed ? 1 : 0)
}
main()
