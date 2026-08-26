import { chromium } from 'playwright'
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
for (const yaw of [0, 0.8, 1.571, 2.4, 3.142, 3.9, 4.712, 5.5]) {
  const browser = await chromium.launch({ headless: true, args: ARGS })
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  const warn = []
  page.on('console', m => { if (m.type() === 'warning') warn.push(m.text()) })
  await page.goto(`${BASE}/?shot=1&time=0.62&warmup=64&spawn=-920,80&caryaw=${yaw}&drive=&frame=132`, { waitUntil: 'load', timeout: 60000 })
  await page.evaluate(() => window.__ready)
  const c = await page.evaluate(() => window.__trench.car())
  console.log(`caryaw ${yaw.toFixed(3)}  spawn (${c.x.toFixed(1)}, ${c.z.toFixed(1)})  pitch ${(c.pitch*57.3).toFixed(1).padStart(6)}  roll ${(c.roll*57.3).toFixed(1).padStart(6)}  tilt ${(Math.atan(Math.hypot(Math.tan(c.pitch), Math.tan(c.roll)))*57.3).toFixed(1)}  ${warn[0] ?? ''}`)
  await page.close(); await browser.close()
}
