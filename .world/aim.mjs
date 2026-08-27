// Find a real, tall collision proxy near a spawn and verify the kart stops on it.
import { chromium } from 'playwright'
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal',
  '--use-gl=angle', '--enable-gpu', '--no-sandbox']
const spawns = (process.argv[2] ?? '2160,-420').split(';')
const b = await chromium.launch({ headless: true, args: ARGS })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)))
for (const sp of spawns) {
  const url = `${BASE}/?shot=1&time=0.42&car=1&warmup=40&spawn=${sp}&drive=&frame=2`
  await p.goto(url, { waitUntil: 'load', timeout: 40000 })
  await p.evaluate(() => window.__ready)
  const r = await p.evaluate(() => {
    const t = window.__trench
    const c = t.car()
    const out = []
    for (const s of t.solids()) {
      const h = t.heightAt(s.x, s.z)
      const rise = s.top - h
      const d = Math.hypot(s.x - c.x, s.z - c.z)
      if (rise > 1.2 && s.radius > 1.0 && d > 12 && d < 90) {
        out.push({ x: +s.x.toFixed(1), z: +s.z.toFixed(1), rise: +rise.toFixed(2), r: +s.radius.toFixed(2), d: +d.toFixed(1) })
      }
    }
    out.sort((a, b2) => b2.r * b2.rise - a.r * a.rise)
    return { car: { x: +c.x.toFixed(1), z: +c.z.toFixed(1) }, biome: t.biomeAt(c.x, c.z).biome, n: t.solids().length, top: out.slice(0, 6) }
  })
  console.log(sp, JSON.stringify(r))
}
await b.close()
