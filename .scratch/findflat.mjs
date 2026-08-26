import { chromium } from 'playwright'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const browser = await chromium.launch({ headless: true, args: ARGS })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
await page.goto(`${BASE}/?shot=1&car=0&warmup=2`, { waitUntil: 'load', timeout: 60000 })
await page.evaluate(() => window.__ready)
const res = await page.evaluate(() => {
  const H = window.__trench.heightAt
  const OB = window.__trench.obstacles()
  const slope = (x, z) => {
    const h = H(x, z)
    let w = 0
    for (const [dx, dz] of [[4,0],[-4,0],[0,4],[0,-4],[3,3],[-3,-3],[3,-3],[-3,3]]) {
      w = Math.max(w, Math.abs(H(x+dx, z+dz) - h) / Math.hypot(dx, dz))
    }
    return Math.atan(w)
  }
  const clear = (x, z, pad) => {
    for (const o of OB) { const d = Math.hypot(x-o.x, z-o.z); if (d < o.r + pad) return false }
    return true
  }
  const out = []
  // Coarse sweep of the near world.
  for (let x = -1400; x <= 1400; x += 40) {
    for (let z = -1400; z <= 1400; z += 40) {
      if (Math.hypot(x, z) > 1500) continue
      // Worst slope over a 70 m disc, sampled on 3 rings.
      let worst = 0, ok = true, minH = 1e9
      for (const r of [0, 12, 22, 32]) {
        const n = r === 0 ? 1 : 12
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2
          const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r
          worst = Math.max(worst, slope(px, pz))
          minH = Math.min(minH, H(px, pz))
          if (!clear(px, pz, 5)) ok = false
        }
      }
      if (!ok) continue
      out.push({ x, z, worst, minH, centreSlope: slope(x, z) })
    }
  }
  out.sort((a, b) => (a.worst + a.centreSlope * 2) - (b.worst + b.centreSlope * 2))
  return { top: out.slice(0, 14), n: out.length }
})
console.log(`${res.n} candidate discs`)
for (const c of res.top) {
  console.log(`  (${c.x}, ${c.z})  worst slope over 32m disc ${(c.worst*57.3).toFixed(1)} deg   centre ${(c.centreSlope*57.3).toFixed(1)} deg   min h ${c.minH.toFixed(1)}`)
}
await browser.close()
