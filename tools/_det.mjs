// Is a capture reproducible? Same URL, N times in one process, pixel-diffed
// against the first.
//
// This exists because a `npm run shots` run that overlaps another session's
// build produces frames from TWO different bundles, and its gate output is a
// blend of both. Measured: two runs of the same source differed on 65-75% of
// pixels on the car frames and flipped `car-airborne` from FORMLESS to
// OVER-DETAILED, which read exactly like a regression in the change under test
// and was not one.
//
// Three loads in one process are bit-identical, so a difference BETWEEN runs is
// never the build. Run this before believing any A/B on the shared gates.
//
//   DET_Q=<query string>  what to load        DET_N=<n>  how many times
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
const A = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const Q = process.env.DET_Q ?? 'time=0.62&warmup=64&spawn=1710,1440&caryaw=1.571&drive=throttle:0-9999&frame=286&camyaw=0.9&camarm=0.8&camlift=0.2'
const N = Number(process.env.DET_N ?? 3)
const b = await chromium.launch({ headless: true, args: A })
const shots = []
for (let k = 0; k < N; k++) {
  const p = await b.newPage({ viewport: { width: 800, height: 450 } })
  await p.goto(`http://127.0.0.1:5173/?shot=1&${Q}`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction('window.__ready !== undefined', null, { timeout: 90_000 })
  await p.evaluate('window.__ready')
  const car = await p.evaluate(() => { const c = window.__trench.car(); return c ? `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}` : 'none' })
  const veg = await p.evaluate(() => JSON.stringify(window.__trench.veg()))
  shots.push({ buf: PNG.sync.read(await p.screenshot()), car, veg })
  await p.close()
}
for (let k = 1; k < N; k++) {
  const a = shots[0].buf, c = shots[k].buf
  let n = 0, sum = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i]-c.data[i]) + Math.abs(a.data[i+1]-c.data[i+1]) + Math.abs(a.data[i+2]-c.data[i+2])
    if (d > 6) n++
    sum += d
  }
  const px = a.data.length / 4
  console.log(`run 0 vs ${k}: ${(100*n/px).toFixed(2)}% of pixels differ, mean |d| ${(sum/px/3).toFixed(2)}`)
}
for (const [k, s] of shots.entries()) console.log(`  run ${k}  car ${s.car}  veg ${s.veg}`)
await b.close()
