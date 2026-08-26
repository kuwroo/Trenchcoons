import { chromium } from 'playwright'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const errs = []

async function run(q, frames) {
  // A browser per run. Sharing one lost the WebGPU device after ~4 pages of
  // 500-frame sampling and every later evaluate died with "execution context
  // destroyed", which reads exactly like a page error but is not one.
  const browser = await chromium.launch({ headless: true, args: ARGS })
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } })
  page.on('pageerror', e => errs.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  await page.goto(`${BASE}/?shot=1&frame=99999&${q}`, { waitUntil: 'load', timeout: 60000 })
  const out = await page.evaluate(async (n) => {
    const o = []
    const T = window.__trench
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
  await page.close()
  await browser.close()
  return out
}

const WARM = 64
const FLAT = 'time=0.62&warmup=64&spawn=600,880&caryaw=0'
const JUMP = 'time=0.45&warmup=64&spawn=-160,1040&caryaw=3.142'
const avg = a => a.reduce((x, y) => x + y, 0) / a.length

// ── 1. steady-state camera arm ───────────────────────────────────────────────
let s = await run(`${FLAT}&drive=throttle:0-99999`, 300)
const tail = s.slice(-60)
console.log(`STEADY: speed ${avg(tail.map(r=>r.speed)).toFixed(2)} m/s`)
console.log(`  XZ arm  ${avg(tail.map(r=>Math.hypot(r.camx-r.x, r.camz-r.z))).toFixed(2)} m   (nominal RIG.arm+armSpeed = 8.00)`)
console.log(`  height  ${avg(tail.map(r=>r.camy-r.y)).toFixed(2)} m   (nominal 2.55..3.10)`)
console.log(`  min height offset over the whole run: ${Math.min(...s.map(r=>r.camy-r.y)).toFixed(2)} m`)

// ── 2. ballistic A/B ─────────────────────────────────────────────────────────
const a = await run(`${JUMP}&drive=throttle:0-9999`, 520)
let i0 = -1, i1 = -1
for (let i = 0; i < a.length; i++) {
  if (a[i].contacts !== 0) continue
  let j = i
  while (j < a.length && a[j].contacts === 0) j++
  if (j - i >= 10) { i0 = i; i1 = j - 1; break }
  i = j
}
if (i0 < 0) { console.log('NO AIRBORNE WINDOW FOUND'); }
else {
  const air = a.slice(i0, i1 + 1)
  const F0 = a[i0].f, F1 = a[i1].f
  console.log(`AIRBORNE clock ${F0}..${F1} = script ${F0-WARM}..${F1-WARM}  (${air.length} frames)`)
  console.log(`  max |aLat| airborne ${Math.max(...air.map(r=>Math.abs(r.aLat))).toFixed(2)} m/s^2   (was 37.9)`)
  console.log(`  roll airborne: ${(air[0].roll*57.3).toFixed(2)} -> ${(air[air.length-1].roll*57.3).toFixed(2)} deg`)
  console.log(`  squash at F0+1: ${a[i0+1].squash.toFixed(4)}   at F0+20: ${(a[i0+20]?.squash ?? NaN).toFixed(4)}`)
  const b = await run(`${JUMP}&drive=throttle:0-9999,steerLeft:${F0-WARM}-${F1-WARM+1}`, 520)
  const bAir = b.slice(i0, i1 + 1)
  console.log(`  steered run, contacts inside window: max ${Math.max(...bAir.map(r=>r.contacts))}`)
  console.log(`  steered run, max |aLat| airborne ${Math.max(...bAir.map(r=>Math.abs(r.aLat))).toFixed(2)} m/s^2`)
  // Measured at TOUCHDOWN, not later: after the wheels are down the two runs
  // have different headings and drive apart legitimately.
  const tA = a[i1 + 1], tB = b[i1 + 1]
  if (tA && tB) {
    console.log(`  touchdown no-steer (${tA.x.toFixed(2)}, ${tA.z.toFixed(2)}) yaw ${(tA.yaw*57.3).toFixed(1)}`)
    console.log(`  touchdown steered  (${tB.x.toFixed(2)}, ${tB.z.toFixed(2)}) yaw ${(tB.yaw*57.3).toFixed(1)}`)
    console.log(`  CARVE THROUGH THE AIR: ${Math.hypot(tB.x-tA.x, tB.z-tA.z).toFixed(3)} m   (was 14.1 m)`)
  }
  // landing telemetry sweep for re-picking the capture frames
  console.log('  post-touchdown squash:', a.slice(i1+1, i1+14).map(r => `${r.f-WARM}:${r.squash.toFixed(3)}`).join(' '))
}

// ── 3. bump stop ─────────────────────────────────────────────────────────────
s = await run(`${FLAT}&drive=throttle:0-9999,steerLeft:60-9999`, 320)
let pinned = 0, cur = 0
for (const r of s) {
  if (r.wheels[1].compression > 0.2999) { cur++; pinned = Math.max(pinned, cur) } else cur = 0
}
console.log(`CORNER: longest FR run at the 0.30 clamp ${pinned} frames (was ~30);  max roll ${(Math.max(...s.map(r=>Math.abs(r.roll)))*57.3).toFixed(1)} deg`)

if (errs.length) console.log('PAGE ERRORS:', [...new Set(errs)].slice(0, 6))
