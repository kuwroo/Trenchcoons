// Headless capture harness.
//
// The flag combination below is not optional and not obvious: plain
// --enable-unsafe-swiftshader yields NO WebGPU adapter at all in headless
// Chromium. --use-angle=metal is what actually gets a real Metal-backed
// adapter (verified: vendor=apple, architecture=metal-3, compute shaders OK).
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']

// Named states. Each becomes shots/<name>.png and is what critics compare
// against refs/. Keep these stable — renaming breaks the diff history.
export const SHOTS = [
  { name: 'greybox-morning', q: 'time=0.36&pos=0,12,40&look=0,-0.18' },
  { name: 'greybox-sunrise', q: 'time=0.25&pos=0,12,40&look=0,-0.18' },
  { name: 'greybox-noon',    q: 'time=0.50&pos=0,12,40&look=0,-0.18' },
  { name: 'greybox-dusk',    q: 'time=0.75&pos=0,12,40&look=0,-0.18' },
]

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = process.env.OUT_DIR ?? 'shots'
const W = Number(process.env.SHOT_W ?? 1600)
const H = Number(process.env.SHOT_H ?? 900)

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
  const page = await browser.newPage({ viewport: { width: W, height: H } })

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const list = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS
  let failed = 0

  for (const s of list) {
    const url = `${BASE}/?shot=1&${s.q}`
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
      await page.evaluate(() => window.__ready ?? Promise.reject(new Error('__ready missing')))
      const file = path.join(OUT, `${s.name}.png`)
      await page.screenshot({ path: file })
      console.log(`  ok   ${s.name.padEnd(20)} ${url}`)
    } catch (e) {
      failed++
      console.log(`  FAIL ${s.name.padEnd(20)} ${String(e).split('\n')[0]}`)
    }
  }

  if (errors.length) {
    console.log('\npage errors:')
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e)
    failed += errors.length
  }
  await browser.close()
  console.log(failed ? `\n${failed} problem(s)` : `\n${list.length} shot(s) ok`)
  process.exit(failed ? 1 : 0)
}
main()
