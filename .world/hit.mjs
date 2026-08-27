// Verify a collision capture: does the kart actually stop on the rock?
import { chromium } from 'playwright'
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal',
  '--use-gl=angle', '--enable-gpu', '--no-sandbox']
// argv: spawn tx tz frames yawList
const [spawn, tx, tz, frames] = process.argv.slice(2)
const b = await chromium.launch({ headless: true, args: ARGS })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)))
// derive the yaw from the geometry once, using the car's settled spawn
await p.goto(`${BASE}/?shot=1&time=0.42&car=1&warmup=40&spawn=${spawn}&drive=&frame=2`, { waitUntil: 'load', timeout: 40000 })
await p.evaluate(() => window.__ready)
const c0 = await p.evaluate(() => { const c = window.__trench.car(); return { x: c.x, z: c.z } })
const dx = Number(tx) - c0.x, dz = Number(tz) - c0.z
const cands = {
  'atan2(-dx,-dz)': Math.atan2(-dx, -dz),
  'atan2(dx,dz)': Math.atan2(dx, dz),
  'atan2(dx,-dz)': Math.atan2(dx, -dz),
  'atan2(-dx,dz)': Math.atan2(-dx, dz),
}
console.log('car', c0, 'target', tx, tz, 'dist', Math.hypot(dx, dz).toFixed(1))
for (const [name, yaw] of Object.entries(cands)) {
  const url = `${BASE}/?shot=1&time=0.42&car=1&warmup=40&spawn=${spawn}&caryaw=${yaw.toFixed(4)}`
    + `&drive=throttle:0-9999@0.9&frame=${frames}`
  await p.goto(url, { waitUntil: 'load', timeout: 60000 })
  await p.evaluate(() => window.__ready)
  const r = await p.evaluate(() => {
    const c = window.__trench.car()
    return { x: +c.x.toFixed(1), z: +c.z.toFixed(1), speed: +c.speed.toFixed(2), contact: c.contact, impact: +(c.impact ?? 0).toFixed(2) }
  })
  const d = Math.hypot(r.x - Number(tx), r.z - Number(tz))
  console.log(`  yaw=${yaw.toFixed(4)} ${name.padEnd(16)} -> ${JSON.stringify(r)} distToRock ${d.toFixed(1)}`)
}
await b.close()
