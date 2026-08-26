import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
const ARGS = ['--use-angle=metal','--enable-unsafe-swiftshader']
const BASE = 'http://127.0.0.1:4173'
const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
const OPTS = [[-1.0,1.0],[-0.7,0.85],[-0.4,1.0],[-0.2,0.9],[0.3,0.9],[-0.7,0.7]]
const b = await chromium.launch({ headless: true, args: ARGS })
const p = await b.newPage({ viewport: { width: 1600, height: 900 } })
for (const [ya, ar] of OPTS) {
  const q = `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=100&camyaw=${ya}&camarm=${ar}`
  await p.goto(`${BASE}/?shot=1&${q}`, { waitUntil: 'load', timeout: 60000 })
  await p.evaluate(() => window.__ready)
  await p.screenshot({ path: 'shots/car-corner.png' })
  const sh = execSync('node tools/shadow.mjs || true').toString().split('\n').find(l => /car-corner\.png\s+0/.test(l)) ?? ''
  const pa = execSync('node tools/palette.mjs || true').toString().split('\n').find(l => /^\s*car-corner\.png\s+(FAIL|ok)/.test(l)) ?? ''
  console.log(`yaw ${ya} arm ${ar} | ${sh.trim()} | ${pa.trim()}`)
}
await b.close()
