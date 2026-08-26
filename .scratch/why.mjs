import { chromium } from 'playwright'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const browser = await chromium.launch({ headless: true, args: ARGS })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
await page.goto(`${BASE}/?shot=1&car=0&warmup=2`, { waitUntil: 'load', timeout: 60000 })
await page.evaluate(() => window.__ready)
const r = await page.evaluate(() => {
  const H = window.__trench.heightAt, OB = window.__trench.obstacles()
  const slope = (x, z) => {
    let lo = 1e18, hi = -1e18
    for (let i = 0; i < 16; i++) { const a = i/16*Math.PI*2; const h = H(x+Math.cos(a)*1.35, z+Math.sin(a)*1.35); lo=Math.min(lo,h); hi=Math.max(hi,h) }
    return Math.atan((hi-lo)/2.7)
  }
  const clear = (x,z) => { for (const o of OB) if (Math.hypot(x-o.x,z-o.z) < o.r+3.5) return o; return null }
  const probe = (x,z) => ({ x, z, h: H(x,z), slope: slope(x,z)*57.3, ob: clear(x,z) })
  // Sweep a wide grid for the gentlest LEGAL spawn near the origin-ish areas.
  const cands = []
  for (let x = -1400; x <= 1400; x += 20) for (let z = -1400; z <= 1400; z += 20) {
    if (Math.hypot(x, z) > 1450) continue
    const s = slope(x, z)
    if (s > 0.10) continue
    if (clear(x, z)) continue
    // Also want the 30 m of ground the drive scripts will cross to be sane.
    let worst = 0
    for (const rr of [10, 20, 32]) for (let i = 0; i < 8; i++) {
      const a = i/8*Math.PI*2
      worst = Math.max(worst, slope(x+Math.cos(a)*rr, z+Math.sin(a)*rr))
    }
    cands.push({ x, z, s: s*57.3, worst: worst*57.3, h: H(x,z) })
  }
  cands.sort((a,b) => (a.s*2 + a.worst) - (b.s*2 + b.worst))
  return { probe: [probe(-920,80), probe(-876.9,192)], best: cands.slice(0, 12), n: cands.length }
})
console.log('probes:', JSON.stringify(r.probe, null, 1))
console.log(`${r.n} legal spawn cells`)
for (const c of r.best) console.log(`  (${c.x}, ${c.z})  spawn tilt ${c.s.toFixed(1)} deg  worst within 32 m ${c.worst.toFixed(1)} deg  h ${c.h.toFixed(1)}`)
await browser.close()
