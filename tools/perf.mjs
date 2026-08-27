// Runtime check. Screenshots prove a frame renders; they prove nothing about
// whether the game RUNS — frame stability over time, leaks, GPU-side stalls,
// errors that only appear after warmup, or the perf budget under motion.
import { chromium } from 'playwright'

const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const SECONDS = Number(process.env.PERF_SECONDS ?? 12)

// `car=0` is REQUIRED. The vehicle is opt-OUT outside ?shot=1, so without it
// the kart spawns into these scenes, the chase camera follows it, and the run
// measures a close-up of the car instead of the composition it is named after.
// ground-noon spawns at y=-83.8 — 84m down in the lagoon bowl — so the first
// version of this file reported "vsync-locked 60fps" for a near-empty pit view.
const SCENES = [
  { name: 'ground-noon',   q: 'time=0.50&pos=280,14,760&look=-1.15,-0.12&car=0' },
  { name: 'vista-morning', q: 'time=0.36&pos=0,180,700&look=0.6,0.34&car=0' },
  // And one scene that intentionally DOES include the car, since that is what
  // the game actually renders while being played.
  { name: 'driving',       q: 'time=0.36&car=1&drive=throttle:0-9999' },
]

const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
let bad = 0

for (const s of SCENES) {
  // 1920x1080, not 1600x900. CLAUDE.md states the budget as "16.6ms @ 1080p" and
  // this harness was measuring at 1600x900 — 30% fewer pixels — so every number
  // it has ever printed was optimistic against its own stated bar. A critic
  // caught it by re-measuring at 1080p and getting 20.7-34.1 ms where the harness
  // reported 21.8. Overridable for a quick loop, but the DEFAULT is now the
  // budget's own resolution.
  const page = await browser.newPage({
    viewport: {
      width: Number(process.env.PERF_W ?? 1920),
      height: Number(process.env.PERF_H ?? 1080),
    },
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(`${BASE}/?${s.q}`, { waitUntil: 'load', timeout: 30_000 })
  await page.evaluate(() => window.__ready)

  // Sample frame deltas in-page for SECONDS, then report the distribution.
  const stats = await page.evaluate(async (secs) => {
    let dts = []
    let last = performance.now()
    await new Promise((resolve) => {
      const t0 = last
      const tick = () => {
        const now = performance.now()
        dts.push(now - last)
        last = now
        if (now - t0 < secs * 1000) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    // Drop the first second: WebGPU pipeline compilation produces one ~900ms
    // frame on cold start, which would dominate max and hitch counts while
    // telling us nothing about steady-state performance.
    const warm = dts.slice(60)
    const steady = warm.length > 30 ? warm : dts
    steady.sort((a, b) => a - b)
    dts = steady
    const q = (p) => dts[Math.floor(dts.length * p)] ?? 0
    const mem = performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null
    return {
      frames: dts.length,
      p50: q(0.5), p95: q(0.95), p99: q(0.99), max: dts[dts.length - 1] ?? 0,
      // Long frames are what a player actually feels.
      hitches: dts.filter((d) => d > 33).length,
      heapMB: mem,
    }
  }, SECONDS)

  // 16.67ms IS the 60Hz vsync interval, so a healthy vsync-locked frame
  // measures 16.6-16.8. Comparing against 16.6 flags success as failure.
  // What matters is whether we are consistently MISSING vsync.
  const over = stats.p50 > 17.5
  const hitchy = stats.hitches / Math.max(stats.frames, 1) > 0.02
  if (over || hitchy || errors.length) bad++

  console.log(`\n[${s.name}]  ${stats.frames} frames over ${SECONDS}s`)
  console.log(`  p50 ${stats.p50.toFixed(2)}ms  p95 ${stats.p95.toFixed(2)}ms  ` +
              `p99 ${stats.p99.toFixed(2)}ms  max ${stats.max.toFixed(1)}ms`)
  console.log(`  fps(p50) ${(1000 / Math.max(stats.p50, 0.01)).toFixed(0)}` +
              `${over ? '   MISSING VSYNC (>17.5ms)' : '   vsync-locked'}`)
  console.log(`  hitches >33ms: ${stats.hitches}/${stats.frames}` +
              `${hitchy ? '   TOO MANY' : ''}`)
  if (stats.heapMB !== null) console.log(`  js heap ${stats.heapMB.toFixed(1)}MB`)
  if (errors.length) {
    console.log('  ERRORS:')
    for (const e of [...new Set(errors)].slice(0, 6)) console.log('    ' + e.slice(0, 200))
  }
  await page.close()
}

await browser.close()
console.log(bad ? `\n${bad} scene(s) with problems` : '\nruntime ok')
process.exit(bad ? 1 : 0)
