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
// Sample a WIDE GRID, not two points. One pair scored 55.8 and "passed" while
// the user reported seeing no different environments — two arbitrary spots
// differing proves nothing about whether the world contains distinct places.
// Cluster the samples and count how many genuinely separate environments exist.
const GRID = [
  '0,40,0', '900,40,0', '-900,40,0', '0,40,900',
  '1400,40,-1200', '-1400,40,1200', '2200,40,600',
]
const samples = []
for (const g of GRID) samples.push({ pos: g, ...(await sample(g)) })

// Same environment = close in BOTH colour and per-tile detail. A hue shift
// alone is not a biome (ART_BIBLE §1: ground, scatter, rock form, grass density
// and light must all change together).
const near = (a, b) =>
  Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) < 28 && Math.abs(a.sd - b.sd) < 0.012
const clusters = []
for (const s0 of samples) {
  const hit = clusters.find((c) => near(c[0], s0))
  if (hit) hit.push(s0); else clusters.push([s0])
}
const spread = Math.max(...samples.map((a) =>
  Math.max(...samples.map((b) => Math.hypot(a.r-b.r, a.g-b.g, a.b-b.b)))))
check('world has distinct environments', clusters.length >= 3,
  `${clusters.length} distinct of ${GRID.length} sampled (want >=3), max spread ${spread.toFixed(0)}`)


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

// 5. "collisions with rocks and objects".
//
// TIGHTENED, twice over, because the previous form of this check could not
// distinguish a collision from a slow lap of an empty field. It was
//   `coll.blocked || coll.speed < 34`
// on a run that just drove forward from the default spawn — so ANY kart under
// 122 km/h satisfied it whether or not there was a rock anywhere in the world,
// and a critic replaying the collision CAPTURE's own URL found the kart doing
// 35 m/s with `contact` false and nothing bigger than a 28 cm pebble within
// 13 m. The feature works; the test did not test it.
//
// Now: pick the target from `__trench.solids()` by SIZE (a proxy standing over
// 1.2 m above the ground with a radius over 1 m — something that ought to stop a
// kart), aim at it with the build's own yaw convention, and require BOTH
// `contact === true` AND that the kart finished within a couple of metres of the
// proxy's face. The `||` is gone: a stopped kart with no contact is a kart that
// hit terrain, not a rock.
await load('shot=1&car=1&warmup=40&spawn=280,760&drive=&frame=2')
const target = await page.evaluate(() => {
  const t = window.__trench, c = t.car()
  let best = null
  for (const s of t.solids()) {
    const rise = s.top - t.heightAt(s.x, s.z)
    const d = Math.hypot(s.x - c.x, s.z - c.z)
    if (rise < 1.2 || s.radius < 1.0 || d < 12 || d > 90) continue
    const score = s.radius * rise
    if (!best || score > best.score) best = { x: s.x, z: s.z, r: s.radius, d, score }
  }
  // `atan2(-dx, -dz)` is this build's convention; the other three sign
  // combinations were tried and all three drive past. See tools/shots.mjs.
  return best && { ...best, yaw: Math.atan2(-(best.x - c.x), -(best.z - c.z)) }
})
if (!target) {
  check('kart collides with objects', false,
    'no solid proxy over 1.2 m tall within 90 m of the spawn — nothing to hit')
} else {
  await load(`shot=1&car=1&warmup=40&spawn=280,760&caryaw=${target.yaw.toFixed(4)}`
    + '&drive=throttle:0-9999@0.9&frame=150')
  const coll = await page.evaluate(() => {
    const t = window.__trench, c = t.car()
    return { speed: +(c.speed ?? 0).toFixed(1), blocked: !!c.contact, x: c.x, z: c.z }
  })
  const miss = Math.hypot(coll.x - target.x, coll.z - target.z)
  check('kart collides with objects', coll.blocked && miss < target.r + 2.5,
    `aimed at a ${target.r.toFixed(1)} m proxy ${target.d.toFixed(0)} m away; `
    + `stopped ${miss.toFixed(1)} m from its centre at ${coll.speed} m/s, `
    + `contact ${coll.blocked}`)
}

// 6. Does the GROUND actually match the reference?
//
// Added because the world critic's verdict opened with: "All five complaints
// close on their own acceptance test while the frame does not match the
// reference." Every check above can pass on a frame whose colour is wrong,
// because each one asks "is the feature present" rather than "is it right".
//
// Measured within the green family, lit vs shaded — the same comparison
// ART_BIBLE §2 is written from:
//   reference  lit S0.603 / shaded S0.560   dS -0.043
//   ours       lit S0.769 / shaded S0.512   dS +0.257   <- inverted
// and the acid cast is a crushed BLUE channel: lit ground rgb(170,213,40)
// against the reference's rgb(191,219,87). Red and green nearly match.
// Noon, and a look direction chosen to put LIT ground in frame.
//
// The first version used the default sun and framed a slope that happens to sit
// in shadow, so it measured ambient rather than albedo and failed with "no
// green-family pixels found" — true of the frame, and nothing to do with the
// palette. A check on the palette has to look at ground the sun is actually on.
await load('shot=1&car=0&time=0.50&warmup=48&pos=2160,0,-420&eye=6&look=-1.6,-0.08')
const groundPng = await shot(page)
function greenFamily(png) {
  const { width: W, height: H, data } = png
  const px = []
  for (let y = Math.floor(H * 0.45); y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
      if (d < 0.06) continue
      let h
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0))
      else if (mx === g) h = ((b - r) / d + 2)
      else h = ((r - g) / d + 4)
      h = ((h * 60) % 360 + 360) % 360
      if (h < 55 || h > 165) continue
      px.push({ s: mx ? d / mx : 0, v: mx, b: data[i + 2] })
    }
  }
  if (px.length < 50) return null
  px.sort((a, c) => a.v - c.v)
  const k = Math.max(1, Math.floor(px.length * 0.12))
  const avg = (a, f) => a.reduce((t, x) => t + f(x), 0) / a.length
  const lo = px.slice(0, k), hi = px.slice(-k)
  return {
    dS: avg(hi, (x) => x.s) - avg(lo, (x) => x.s),
    shadedV: avg(lo, (x) => x.v),
    litBlue: avg(hi, (x) => x.b),
  }
}
const gf = greenFamily(groundPng)
if (!gf) {
  check('ground colour matches reference', false, 'no green-family pixels found')
} else {
  // Reference: dS -0.043, shaded V 0.588, lit blue 87.
  const okDs = gf.dS < 0.05           // must not GAIN saturation with light
  const okShadow = gf.shadedV > 0.44  // shadows lifted, not crushed
  const okBlue = gf.litBlue > 62      // blue not crushed out of the lit green
  check('ground colour matches reference', okDs && okShadow && okBlue,
    `dS ${gf.dS >= 0 ? '+' : ''}${gf.dS.toFixed(3)} (ref -0.043, must be <+0.05), ` +
    `shaded V ${gf.shadedV.toFixed(3)} (ref 0.588), ` +
    `lit blue ${gf.litBlue.toFixed(0)} (ref 87)`)
}

// 7. Do shadows keep the material's own hue?
//
// The most visible fault in the current build is bright blue pools under the
// trees: shadowed ground takes the SKY's hue instead of a tint of the ground
// beneath it. ART_BIBLE §2 is explicit that shadows are tinted toward sky —
// biased about 40 degrees off the lit hue — not replaced by it.
//
//   reference   lit H99 -> shadow H136    37 degrees, stays green
//   ours        lit H99 -> shadow H213   114 degrees, albedo erased
//
// Measured as the hue gap between lit and shadowed ground in ONE frame, so it
// cannot be satisfied by changing the whole scene's colour.
await load('shot=1&car=0&time=0.42&warmup=48&pos=2160,0,-420&eye=6&look=-1.6,-0.08')
const shPng = await shot(page)
function litVsShadowHue(png) {
  const { width: W, height: H, data } = png
  const px = []
  for (let y = Math.floor(H * 0.45); y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
      if (d < 0.05) continue
      let h
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0))
      else if (mx === g) h = ((b - r) / d + 2)
      else h = ((r - g) / d + 4)
      px.push({ h: ((h * 60) % 360 + 360) % 360, v: mx })
    }
  }
  if (px.length < 200) return null
  px.sort((a, c) => a.v - c.v)
  const k = Math.max(1, Math.floor(px.length * 0.15))
  const circMean = (a) => {
    const x = a.reduce((t, p) => t + Math.cos(p.h * Math.PI / 180), 0) / a.length
    const y = a.reduce((t, p) => t + Math.sin(p.h * Math.PI / 180), 0) / a.length
    return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360
  }
  const litH = circMean(px.slice(-k)), shH = circMean(px.slice(0, k))
  let gap = Math.abs(litH - shH); if (gap > 180) gap = 360 - gap
  return { litH, shH, gap }
}
const sh = litVsShadowHue(shPng)
if (!sh) {
  check('shadows keep material hue', false, 'not enough chromatic ground pixels')
} else {
  check('shadows keep material hue', sh.gap <= 60,
    `lit H${sh.litH.toFixed(0)} -> shadow H${sh.shH.toFixed(0)}, ` +
    `gap ${sh.gap.toFixed(0)}deg (ref 37, must be <=60)`)
}

console.log(errs.length ? `\npage errors: ${[...new Set(errs)].slice(0,3).join(' | ')}` : '\nno page errors')
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed}/${results.length} complaints still unfixed` : `\nall ${results.length} complaints addressed`)
await browser.close()
process.exit(failed ? 1 : 0)
