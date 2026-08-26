import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
const ARGS = ['--use-angle=metal','--enable-unsafe-swiftshader']
const BASE = 'http://127.0.0.1:4173'
const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
const V = JSON.parse(process.argv[2])
fs.mkdirSync('.scratch/sw', { recursive: true })
const b = await chromium.launch({ headless: true, args: ARGS })
const p = await b.newPage({ viewport: { width: 1600, height: 900 } })
for (const [n, q] of V) {
  await p.goto(`${BASE}/?shot=1&${q}`, { waitUntil: 'load', timeout: 60000 })
  await p.evaluate(() => window.__ready)
  await p.screenshot({ path: `.scratch/sw/${n}.png` })
}
await b.close()
const out = execSync(`node tools/palette.mjs ${V.map(v=>'.scratch/sw/'+v[0]+'.png').join(' ')}`).toString()
for (const line of out.split('\n')) if (/\.png/.test(line)) console.log(line)
