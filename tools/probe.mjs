// Diagnostic probe: drive a scripted URL, then map __trench.deform on a grid.
// Not a gate. Prints max stored mask/depth and where they are.
import { chromium } from 'playwright'

const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'

const PAN = 'time=0.62&deform=1&warmup=64&spawn=-1000,150&caryaw=0'
const PAN_RUN = 'drive=throttle:0-150@0.62,brake:150-235'
const q = process.env.PROBE_Q ?? `${PAN}&${PAN_RUN}&frame=400&camarm=3.0`
const HALF = Number(process.env.PROBE_HALF ?? 40)
const STEP = Number(process.env.PROBE_STEP ?? 0.5)

const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const url = `${BASE}/?shot=1&${q}`
console.log('URL', url)
const t0 = Date.now()
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__ready !== undefined', null, { timeout: 60_000 })
await page.evaluate('window.__ready')
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const out = await page.evaluate(({ HALF, STEP }) => {
  const t = window.__trench
  const car = t.car ? t.car() : null
  const cx = car ? car.x : 0
  const cz = car ? car.z : 0
  let best = { mask: -1 }
  let bestDepth = { depth: -1 }
  let nonzero = 0
  let total = 0
  const rows = []
  for (let dz = -HALF; dz <= HALF; dz += STEP) {
    for (let dx = -HALF; dx <= HALF; dx += STEP) {
      const s = t.deform ? t.deform(cx + dx, cz + dz) : null
      if (!s) continue
      total++
      if (s.mask > 0.001) nonzero++
      if (s.mask > best.mask) best = { mask: s.mask, depth: s.depth, wet: s.wet, x: cx + dx, z: cz + dz }
      if (s.depth > bestDepth.depth) bestDepth = { ...s, x: cx + dx, z: cz + dz }
    }
  }
  // a coarse ASCII map of mask, 41x41
  const N = 41
  for (let j = 0; j < N; j++) {
    let line = ''
    for (let i = 0; i < N; i++) {
      const x = cx + (i / (N - 1) * 2 - 1) * HALF
      const z = cz + (j / (N - 1) * 2 - 1) * HALF
      const s = t.deform ? t.deform(x, z) : null
      const m = s ? s.mask : 0
      line += m > 0.75 ? '#' : m > 0.5 ? '+' : m > 0.25 ? ':' : m > 0.02 ? '.' : ' '
    }
    rows.push(line)
  }
  // Cross-section through the strongest point of the mark, along x and along
  // z; the narrower of the two is the track's width, because the track runs
  // along the other axis. Quarter-max, so the shoulder is not counted twice.
  const width = (axis) => {
    const cut = best.mask * 0.25
    let w = 0
    for (let d = -6; d <= 6; d += 0.03125) {
      const s = axis === 0 ? t.deform(best.x + d, best.z) : t.deform(best.x, best.z + d)
      if (s && s.mask >= cut) w += 0.03125
    }
    return w
  }
  const wx = width(0)
  const wz = width(1)
  return { car: car && { x: car.x, z: car.z, speed: car.speed, yaw: car.yaw, slipRatio: car.slipRatio }, best, bestDepth, nonzero, total, rows, frame: t.frame(), widthX: wx, widthZ: wz, trackWidth: Math.min(wx, wz) }
}, { HALF, STEP })

console.log('frame', out.frame, 'car', out.car)
console.log('grid samples', out.total, 'nonzero mask', out.nonzero)
console.log('max mask', JSON.stringify(out.best))
console.log('max depth', JSON.stringify(out.bestDepth))
console.log('track width @ quarter-max: x', out.widthX.toFixed(3), 'z', out.widthZ.toFixed(3), '-> across-track', out.trackWidth.toFixed(3), 'm')
console.log(out.rows.join('\n'))
const scan = await page.evaluate(async () => {
  const d = window.__trenchDeform
  if (!d) return null
  return { near: await d.scan('near'), committed: await d.scan('committed'), stamps: d.stamps() }
})
for (const k of ['near', 'committed']) {
  const t = scan?.[k]
  if (!t) continue
  const { map, ...rest } = t
  console.log(k.toUpperCase(), JSON.stringify(rest))
  console.log(map.map((l, i) => String(i * (t.res / 64)).padStart(5) + ' |' + l + '|').join('\n'))
}
console.log('stamps', JSON.stringify(scan?.stamps))
if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 12).join('\n'))
await browser.close()
