import { chromium } from 'playwright'
const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = 'http://127.0.0.1:4173'
const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', e => console.log('ERR', String(e)))
for (const spec of process.argv.slice(2)) {
  const i = spec.indexOf('='); const name = spec.slice(0, i); const q = spec.slice(i + 1)
  await page.goto(`${BASE}/forge.html?shot=1&${q}`, { waitUntil: 'load' })
  await page.evaluate(() => window.__ready)
  await page.screenshot({ path: `.critic2/${name}.png` })
  console.log('ok', name)
}
await browser.close()
