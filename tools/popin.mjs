// Scatter pop-in gate.
//
// The report this exists for is "trees and rocks spawn and despawn in front of
// my eyes as I drive", and it has been made twice. The first fix aligned the
// per-band lattices so a form could not TELEPORT across a band radius, which was
// real and did not touch the actual fault: a band that visits every 2nd lattice
// cell can carry at most a quarter of the authored density, so three quarters of
// everything beyond the near ring did not exist and materialised at a fixed
// radius. Measured at the meadow site, instances per hectare:
//
//     45-55 m  31.83      200-230 m  9.87      460-560 m  1.56
//     55-65 m   7.96      230-260 m  2.17      560-620 m  0.63
//
// A frame cannot show that and a screenshot gate cannot either — every frame is
// self-consistent, and what changes is which frame you get. So this measures the
// DRAWN INSTANCE SET through `__trench.scatterAt`, which is the same class of
// whole-field readback the water work needed for three of its four bugs.
//
// TWO CHECKS, and they fail on different things, which is why there are two:
//
//   CONTINUITY   density against distance, pooled over sites, in geometric rings.
//                A stride ceiling shows up as a cliff at a band radius.
//   APPEARANCE   how many PIXELS of a form arrive in one streaming step, on the
//                step it first appears. Continuity alone is satisfied by a set
//                that churns its identity — the same average density made of
//                different forms — so this pins each individual appearance.
//
// THE APPEARANCE METRIC IS IN PIXELS AND THE FIRST VERSION WAS NOT. It measured
// the fade as a FRACTION of full scale, and failed the build on a clover
// arriving at 0.392 at 49 m — which is 0.078 m of plant subtending 1.5 px. A
// fraction of scale says nothing about whether an appearance can be seen; the
// whole design thins each form where it is SMALL ON SCREEN, so the gate has to
// measure the same quantity the fix is built on. Height in metres over distance,
// times the focal length in pixels.
//
// Both are verified against their own off-case; see `--offcase` below for what
// each reads when its mechanism is disabled. A gate that cannot fail is worse
// than none, and two gates in CLAUDE.md passed with their feature switched off.
import { chromium } from 'playwright'

const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
/**
 * The streaming step to diff across: `BAND_TOLERANCE[0]` in src/world/scatter.ts.
 *
 * This is not a free parameter. The metric is "how much of a form can arrive in
 * ONE streaming update", so it has to be the distance that actually triggers
 * one. Diffing across 12 m when the near band rebuilds every 3 m measures four
 * updates at once and reports a pop that never happens.
 */
const STEP = 3

// Twelve sites, so a ring's count is a few hundred rather than a few and the
// check is not reading Poisson noise. Spread across biomes on purpose: the
// densities, the grove clumping and the wading rules all differ per biome.
const SITES = [
  [2160, -420], [800, -1600], [2400, -800], [1600, 0], [1600, -800], [-800, 2400],
  [800, 1600], [-2400, -2400], [1600, 800], [0, 0], [-1600, 1200], [2400, 2000],
]

// Geometric rings. A 1.18 ratio means the TRUE falloff — density as d^-1.5 —
// costs 1.18^1.5 = 1.28x per step, so a ceiling of 2.2 leaves real headroom and
// still catches a stride cliff, which arrives as 4 x 1.28 = 5.1x.
const RING_LO = 20
const RING_HI = 1120
const RING_RATIO = 1.18
const STEP_CEIL = 2.2
/** Rings with fewer than this are dropped: a ratio on 3 instances is noise. */
const RING_MIN_N = 25
/**
 * Pixels of drawn height an instance may gain on the step it first appears,
 * at 1600x900 and the chase camera's 58-degree vertical field of view.
 *
 * `focal = (H / 2) / tan(fov / 2)` = 450 / tan(29 deg) = 812 px, so a form of
 * height `h` at distance `d` subtends `h / d * 812` pixels.
 *
 * 8 px is about the size at which a mid-grey blob against grass becomes a thing
 * rather than a texture. The ceiling sits between three MEASURED states rather
 * than being chosen, and both off-cases were run — a gate that cannot fail is
 * worse than none, and two gates in CLAUDE.md passed with their feature off:
 *
 *   shipped                                         0.2 px   ok
 *   `THIN_FADE` 0.55 -> 0.02 (rank cut, no fade)   17.7 px   FAIL
 *   `BAND_STRIDE` back to a ceiling per band       138.4 px  FAIL, and the
 *                                                  continuity check fails with
 *                                                  it at 2.54x across 55 m
 *
 * The last of those is the original bug: a 9 m `qn-common-2` arriving whole at
 * 54 m, in one 3 m step.
 */
const APPEAR_PX_CEIL = 8
const SHOT_H = 900
const CAM_FOV = 58
const FOCAL = (SHOT_H / 2) / Math.tan((CAM_FOV / 2) * Math.PI / 180)
const FADE_RANGE = 200

const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`${BASE}/?shot=1&time=0.62&warmup=8`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__ready !== undefined', null, { timeout: 90_000 })
await page.evaluate('window.__ready')

const out = await page.evaluate((cfg) => {
  const t = window.__trench
  if (!t.scatterAt) throw new Error('no __trench.scatterAt — is this the current bundle?')
  const edges = [cfg.RING_LO]
  while (edges[edges.length - 1] < cfg.RING_HI) edges.push(edges[edges.length - 1] * cfg.RING_RATIO)
  const rings = edges.slice(0, -1).map((r0, i) => ({ r0, r1: edges[i + 1], n: 0 }))
  let worstPx = 0
  let appearedWorst = null
  let appearedNear = 0
  let total = 0

  for (const [X, Z] of cfg.SITES) {
    const dump = (x, z) => t.scatterAt(x, z).map((c) => ({ ...c, d: Math.hypot(c.x - x, c.z - z) }))
    const a = dump(X, Z)
    total += a.length
    for (const c of a) {
      for (const r of rings) if (c.d >= r.r0 && c.d < r.r1) { r.n++; break }
    }
    // Identity is the WORLD POSITION, because placement is a pure function of
    // the lattice cell — the same instance has the same xz in both dumps.
    const b = dump(X + cfg.STEP, Z)
    const seen = new Set(a.map((c) => `${c.x.toFixed(2)},${c.z.toFixed(2)}`))
    for (const c of b) {
      if (seen.has(`${c.x.toFixed(2)},${c.z.toFixed(2)}`)) continue
      if (c.d >= cfg.FADE_RANGE) continue
      appearedNear++
      const px = c.h / c.d * cfg.FOCAL
      if (px > worstPx) {
        worstPx = px
        appearedWorst = {
          d: +c.d.toFixed(0), key: c.key, fade: +c.fade.toFixed(3),
          drawnH: +c.h.toFixed(3), px: +px.toFixed(1),
        }
      }
    }
  }
  // Per hectare, so rings of different width are comparable.
  const prof = rings.map((r) => ({
    r0: r.r0, r1: r.r1, n: r.n,
    perHa: r.n / (Math.PI * (r.r1 * r.r1 - r.r0 * r.r0) / 1e4 * cfg.SITES.length),
  }))
  return { prof, worstPx, appearedWorst, appearedNear, total }
}, { SITES, STEP, RING_LO, RING_HI, RING_RATIO, FADE_RANGE, FOCAL })

const usable = out.prof.filter((r) => r.n >= RING_MIN_N)
let worstStep = { ratio: 0 }
for (let i = 1; i < usable.length; i++) {
  const ratio = usable[i - 1].perHa / usable[i].perHa
  if (ratio > worstStep.ratio) worstStep = { ratio, from: usable[i - 1], to: usable[i] }
}

console.log(`${out.total} instances over ${SITES.length} sites`)
console.log('\ndensity vs distance, pooled (instances per hectare per site)')
for (const r of out.prof) {
  const mark = r.n < RING_MIN_N ? '  (thin, not checked)' : ''
  console.log(`  ${r.r0.toFixed(0).padStart(4)}-${r.r1.toFixed(0).padStart(4)} m  n ${String(r.n).padStart(5)}  ${r.perHa.toFixed(2).padStart(7)}/ha${mark}`)
}

const fails = []
console.log('\ncontinuity — largest drop between adjacent rings')
if (worstStep.from) {
  console.log(`  ${worstStep.from.r0.toFixed(0)}-${worstStep.from.r1.toFixed(0)} m -> ` +
    `${worstStep.to.r0.toFixed(0)}-${worstStep.to.r1.toFixed(0)} m   ` +
    `${worstStep.from.perHa.toFixed(2)} -> ${worstStep.to.perHa.toFixed(2)}  ` +
    `ratio ${worstStep.ratio.toFixed(2)}  ceiling ${STEP_CEIL}`)
  if (worstStep.ratio > STEP_CEIL) {
    fails.push(`density falls ${worstStep.ratio.toFixed(2)}x between ` +
      `${worstStep.from.r0.toFixed(0)} m and ${worstStep.to.r1.toFixed(0)} m — a band ceiling, ` +
      `not a falloff (true falloff over one ring is ${RING_RATIO ** 1.5} x)`)
  }
}

console.log(`\nfirst appearance, within ${FADE_RANGE} m, in pixels of drawn height`)
console.log(`  ${out.appearedNear} appearances over a ${STEP} m step   ` +
  `worst ${out.worstPx.toFixed(1)} px   ceiling ${APPEAR_PX_CEIL} px`)
if (out.appearedWorst) console.log(`  worst: ${JSON.stringify(out.appearedWorst)}`)
if (out.worstPx > APPEAR_PX_CEIL) {
  fails.push(`${out.worstPx.toFixed(1)} px of form appears in one ${STEP} m step ` +
    `within ${FADE_RANGE} m — that is a pop, not a fade`)
}

if (errors.length) console.log('\npage errors', errors.slice(0, 4))
console.log()
if (fails.length) {
  for (const f of fails) console.log(`FAIL  ${f}`)
  process.exitCode = 1
} else {
  console.log('popin ok')
}
await browser.close()
