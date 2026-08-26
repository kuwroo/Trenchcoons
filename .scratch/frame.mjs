import { chromium } from 'playwright'
import fs from 'node:fs/promises'
const ARGS = ['--use-angle=metal','--enable-unsafe-swiftshader']
const BASE = 'http://127.0.0.1:4173'
const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
const JUMP = 'time=0.45&warmup=64&spawn=-160,1040&caryaw=3.142'
const V = [
  ['corner-a', `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=100&camyaw=1.0&camarm=1.0`],
  ['corner-b', `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=100&camyaw=1.35&camarm=1.05`],
  ['corner-c', `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=100&camyaw=-0.7&camarm=1.0`],
  ['landing-a', `${JUMP}&drive=throttle:0-9999&frame=209&camyaw=0.75&camarm=1.0`],
  ['landing-b', `${JUMP}&drive=throttle:0-9999&frame=209&camyaw=1.15&camarm=1.05`],
]
await fs.mkdir('.scratch/fr', { recursive: true })
const b = await chromium.launch({ headless: true, args: ARGS })
const p = await b.newPage({ viewport: { width: 800, height: 450 } })
for (const [n, q] of V) {
  await p.goto(`${BASE}/?shot=1&${q}`, { waitUntil: 'load', timeout: 60000 })
  await p.evaluate(() => window.__ready)
  await p.screenshot({ path: `.scratch/fr/${n}.png` })
  console.log('ok', n)
}
await b.close()
