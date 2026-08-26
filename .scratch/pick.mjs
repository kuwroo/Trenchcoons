import { chromium } from 'playwright'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const WARM = 64
const errs = []

async function run(q, frames) {
  const browser = await chromium.launch({ headless: true, args: ARGS })
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } })
  page.on('pageerror', e => errs.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  await page.goto(`${BASE}/?shot=1&frame=99999&${q}`, { waitUntil: 'load', timeout: 60000 })
  const out = await page.evaluate(async (n) => {
    const o = []; const T = window.__trench
    await new Promise((res) => {
      const tick = () => {
        const c = T.car(); const cam = T.cam()
        if (c) o.push({ f: T.frame(), ...c, camx: cam.x, camy: cam.y, camz: cam.z, fov: cam.fov })
        if (o.length >= n) res(); else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return o
  }, frames)
  await page.close(); await browser.close()
  return out
}
// Kart diagonal ~3.4 m. Projected height in a 900px frame.
const px = r => {
  const d = Math.hypot(r.camx - r.x, r.camy - r.y, r.camz - r.z)
  return 3.4 / (2 * d * Math.tan(r.fov * Math.PI / 360)) * 900
}
const row = (tag, r) => console.log(
  `  ${tag} script ${String(r.f - WARM).padStart(3)}  pitch ${(r.pitch*57.3).toFixed(1).padStart(6)}  terrPitch ${(r.terrainPitch*57.3).toFixed(1).padStart(6)}` +
  `  roll ${(r.roll*57.3).toFixed(1).padStart(6)}  terrRoll ${(r.terrainRoll*57.3).toFixed(1).padStart(6)}` +
  `  sq ${r.squash.toFixed(3).padStart(6)}  spd ${r.speed.toFixed(1).padStart(5)}  slip ${r.slipRatio.toFixed(2)}` +
  `  c${r.contacts}  w[${r.wheels.map(w=>w.compression.toFixed(2)).join(' ')}]  kart~${px(r).toFixed(0)}px`)

const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
const JUMP = 'time=0.45&warmup=64&spawn=-160,1040&caryaw=3.142'

console.log('IDLE (drive=)')
let s = await run(`${FLAT}&drive=`, 200)
for (const f of [100, 132, 160]) { const r = s.find(x => x.f === f + WARM); if (r) row('', r) }

console.log('LAUNCH (throttle:0-400) — max pitch above terrain')
s = await run(`${FLAT}&drive=throttle:0-400`, 140)
let best = s.slice(5, 120).reduce((a, b) => (b.pitch - b.terrainPitch) > (a.pitch - a.terrainPitch) ? b : a)
for (const f of [10, 16, 22, 28, 34, 40, best.f - WARM]) { const r = s.find(x => x.f === f + WARM); if (r) row(f === best.f - WARM ? 'BEST' : '    ', r) }

console.log('CORNER (throttle:0-400@0.55,steerLeft:40-400) — max |roll - terrainRoll| with 4 contacts')
s = await run(`${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400`, 260)
const grounded = s.slice(70).filter(r => r.contacts === 4)
best = grounded.reduce((a, b) => Math.abs(b.roll - b.terrainRoll) > Math.abs(a.roll - a.terrainRoll) ? b : a, grounded[0])
for (const f of [80, 90, 100, 110, 120, 140, 170, best.f - WARM]) { const r = s.find(x => x.f === f + WARM); if (r) row(f === best.f - WARM ? 'BEST' : '    ', r) }

console.log('JUMP (throttle:0-9999)')
s = await run(`${JUMP}&drive=throttle:0-9999`, 520)
let i0 = -1, i1 = -1
for (let i = 0; i < s.length; i++) {
  if (s[i].contacts !== 0) continue
  let j = i; while (j < s.length && s[j].contacts === 0) j++
  if (j - i >= 10) { i0 = i; i1 = j - 1; break }
  i = j
}
console.log(`  airborne script ${s[i0].f-WARM}..${s[i1].f-WARM}`)
for (const k of [i0+2, i0+8, i0+16, i0+24, Math.floor((i0+i1)/2), i1-4]) if (s[k]) row('AIR ', s[k])
const land = s.slice(i1+1, i1+30).reduce((a,b) => b.squash > a.squash ? b : a)
for (const k of [i1+1, i1+3, i1+5, i1+7]) if (s[k]) row('LAND', s[k])
row('PEAK', land)
if (errs.length) console.log('PAGE ERRORS:', [...new Set(errs)].slice(0,6))
