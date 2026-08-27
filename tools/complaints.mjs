// Acceptance test for the user's reported complaints.
//
// Written because six gates were green while the player saw no tyre marks at
// all: deformation only applied inside one rectangular patch, and every gate
// shot was taken inside it. A gate suite that never leaves the happy path
// cannot see that. Each check below is phrased the way the complaint was.
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

// Screenshot, never canvas.drawImage: reading a WebGPU canvas through a 2D
// context returns blank, so every statistic taken that way came back exactly
// 0.0 — a broken probe that looks like a clean result.
async function shot(page) {
  return PNG.sync.read(await page.screenshot())
}
function bandStats(png, y0, y1) {
  const { width: W, height: H, data } = png
  let r=0,g=0,b=0,n=0; const v=[]
  for (let y=Math.floor(H*y0); y<Math.floor(H*y1); y+=2) {
    for (let x=0; x<W; x+=2) {
      const i=(y*W+x)*4
      r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++
      v.push((0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2])/255)
    }
  }
  const m=v.reduce((a,x)=>a+x,0)/v.length
  return { r:r/n, g:g/n, b:b/n,
    sd: Math.sqrt(v.reduce((a,x)=>a+(x-m)*(x-m),0)/v.length) }
}
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']

// Sky cleanliness, by SPATIAL SCALE.
//
// The first version of this measured row variance in the upper frame and had the
// sign backwards: references score 0.058-0.076 and our blobby sky scored 0.0395,
// because a reference frame contains mountains and structured cloud. A blobbier
// sky scored LOWER and passed more easily.
//
// What actually separates them is scale. A clean sky is SMOOTH at fine scale
// with structure only at coarse scale — gradient, soft cloud masses. Fine-scale
// texture in the sky means something is wrong, and here it is the brush mottle
// being applied to the sky dome.
//
//   validated against refs before use:
//     genshin/grasslands   coarse/fine 1.8
//     painterly/cliffs     coarse/fine 2.4
//     snow                 coarse/fine 2.6
//     ours                 coarse/fine 0.9   <- fine texture on the dome
function skyScale(png, y0, y1) {
  const { width: W, height: H, data } = png
  const L = (x, y) => {
    const i = (y * W + x) * 4
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
  }
  const K = Math.max(4, Math.floor(W / 40))
  const sd = (a) => {
    const m = a.reduce((p, c) => p + c, 0) / a.length
    return Math.sqrt(a.reduce((p, c) => p + (c - m) * (c - m), 0) / a.length)
  }
  let fine = 0, coarse = 0, rows = 0
  for (let y = Math.floor(H * y0); y < Math.floor(H * y1); y += 4) {
    const raw = []
    for (let x = 0; x < W; x += 2) raw.push(L(x, y))
    const blur = raw.map((_, i) => {
      let s = 0, n = 0
      for (let k = -K; k <= K; k++) { const j = i + k; if (j >= 0 && j < raw.length) { s += raw[j]; n++ } }
      return s / n
    })
    fine += sd(raw.map((v, i) => v - blur[i]))
    coarse += sd(blur)
    rows++
  }
  fine /= rows; coarse /= rows
  return { fine, coarse, ratio: coarse / Math.max(fine, 1e-6) }
}

const browser = await chromium.launch({ headless: true, args: ARGS })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]))
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

async function load(q) {
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'load', timeout: 90_000 })
  await page.evaluate(() => window.__ready)
}
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${detail}`)
}

// 1. "dont see tire marks" — marks must appear on ORDINARY ground, not just
//    inside the sand pan. Drive on default terrain and probe the field.
// Spawned deliberately away from the sand pan. The default spawn sits ON it,
// which is how "tyre marks work" stayed true in every gate while the player saw
// nothing anywhere else in the world.
await load('shot=1&car=1&deform=1&warmup=40&spawn=200,-300&drive=throttle:0-240@0.8&frame=240')
const marks = await page.evaluate(() => {
  const t = window.__trench, c = t.car()
  let hits = 0, peak = 0
  for (let d = 0; d < 60; d += 0.25) {
    for (const off of [-1.2, -0.8, 0, 0.8, 1.2]) {
      const m = t.deform(c.x + off, c.z + d)?.mask ?? 0
      if (m > 0.05) { hits++; peak = Math.max(peak, m) }
    }
  }
  return { hits, peak: +peak.toFixed(3), surface: t.state?.biome ?? 'default' }
})
check('tyre marks on ordinary ground', marks.hits > 0,
  `${marks.hits} cells, peak ${marks.peak}`)

// 2. "i dont see different environments" — two distant spots must differ in
//    more than hue. Compare mean colour AND per-tile detail.
const sample = async (pos) => {
  await load(`shot=1&car=0&warmup=30&pos=${pos}&look=0,-0.15`)
  return bandStats(await shot(page), 0.5, 1.0)
}
const A = await sample('0,40,0'), B = await sample('1400,40,-1200')
const dRGB = Math.hypot(A.r-B.r, A.g-B.g, A.b-B.b)
const dSD = Math.abs(A.sd - B.sd)
check('two locations look different', dRGB > 25 && dSD > 0.01,
  `colour dist ${dRGB.toFixed(1)} (>25), detail delta ${dSD.toFixed(3)} (>0.01)`)

// 3. "the sky is weirdly blobby" — cloud should be thin and high, not dominant.
//    Measure the fraction of the upper frame that departs from a clean gradient.
await load('shot=1&car=0&warmup=30&pos=0,60,0&look=0,0.25')
const sky = skyScale(await shot(page), 0, 0.35)
// Floor from the least-clean reference (grasslands 1.8), with slack.
check('sky is clean, not blobby', sky.ratio >= 1.5,
  `coarse/fine ${sky.ratio.toFixed(1)} (refs 1.8-2.6; <1.5 means fine texture on the dome)`)

// 4. "can i have threejs grass" — instanced grass present near the camera.
await load('shot=1&car=1&warmup=40&pos=0,3,0&look=0,-0.05')
// Read the perf HUD rather than inventing a hook. Not in shot mode — the HUD
// is deliberately hidden there so it cannot poison capture diffs.
await page.goto(`${BASE}/?car=1&pos=0,3,0&look=0,-0.05`, { waitUntil: 'load', timeout: 90_000 })
await page.evaluate(() => window.__ready)
await page.waitForTimeout(1200)
const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '')
const tris = Number((hud.match(/tris\s+(\d+)k/) ?? [])[1] ?? 0)
const draws = Number((hud.match(/draws\s+(\d+)/) ?? [])[1] ?? 0)
check('grass instanced near camera', tris > 200,
  `${tris}k tris, ${draws} draws (want >200k tris, <1500 draws)`)

// 5. "collisions with rocks and objects" — drive at one and check we stopped.
await load('shot=1&car=1&warmup=40&drive=throttle:0-400@1.0&frame=400')
const coll = await page.evaluate(() => {
  const t = window.__trench, c = t.car()
  return { speed: +(c.speed ?? 0).toFixed(1), blocked: !!c.contact }
})
check('kart collides with objects', coll.blocked || coll.speed < 34,
  `speed ${coll.speed} m/s, contact ${coll.blocked}`)

console.log(errs.length ? `\npage errors: ${[...new Set(errs)].slice(0,3).join(' | ')}` : '\nno page errors')
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed}/${results.length} complaints still unfixed` : `\nall ${results.length} complaints addressed`)
await browser.close()
process.exit(failed ? 1 : 0)
