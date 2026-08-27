// INDEPENDENT write-path probe. Does not use tools/probe.mjs.
import { chromium } from 'playwright'
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const Q = process.env.Q ?? 'time=0.62&deform=1&warmup=64&spawn=-1000,150&caryaw=0&drive=throttle:0-150@0.62,brake:150-235&frame=400&camarm=3.0'
const HALF = Number(process.env.HALF ?? 40)
const STEP = Number(process.env.STEP ?? 0.5)

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 800, height: 450 } })
const msgs = []
page.on('pageerror', e => msgs.push('PAGEERROR ' + String(e)))
page.on('console', m => { const t = m.text(); if (m.type()==='error'||m.type()==='warning'||/GPUValidation|Validation|hazard|usage/i.test(t)) msgs.push(m.type().toUpperCase()+' '+t) })

const url = `${BASE}/?shot=1&${Q}`
console.log('URL', url)
const t0 = Date.now()
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__ready !== undefined', null, { timeout: 120000 })
await page.evaluate('window.__ready')
console.log('ready in', ((Date.now()-t0)/1000).toFixed(1)+'s')

const out = await page.evaluate(({HALF,STEP}) => {
  const t = window.__trench
  if (!t || !t.deform) return { err: 'no __trench.deform' }
  const car = t.car ? t.car() : null
  const cx = car ? car.x : 0, cz = car ? car.z : 0
  let maxMask = 0, maxDepth = 0, nonzero = 0, total = 0
  let at = null, atD = null
  for (let dz=-HALF; dz<=HALF; dz+=STEP) for (let dx=-HALF; dx<=HALF; dx+=STEP) {
    const s = t.deform(cx+dx, cz+dz); if (!s) continue
    total++
    if (s.mask > 0.001) nonzero++
    if (s.mask > maxMask) { maxMask = s.mask; at = {x:cx+dx,z:cz+dz,...s} }
    if (s.depth > maxDepth) { maxDepth = s.depth; atD = {x:cx+dx,z:cz+dz,...s} }
  }
  // ASCII map, 61 cols x 41 rows over the same window
  const rows=[]
  for (let j=0;j<41;j++){ let line=''
    for(let i=0;i<61;i++){
      const x = cx + (i/60*2-1)*HALF, z = cz + (j/40*2-1)*HALF
      const s = t.deform(x,z); const m = s?s.mask:0
      line += m>0.75?'#':m>0.5?'+':m>0.25?':':m>0.02?'.':' '
    } rows.push(line) }
  return { car: car&&{x:car.x,z:car.z,speed:car.speed}, frame: t.frame(), maxMask, maxDepth, at, atD, nonzero, total, rows }
}, {HALF,STEP})
console.log(JSON.stringify({car:out.car,frame:out.frame,maxMask:out.maxMask,maxDepth:out.maxDepth,at:out.at,atD:out.atD,nonzero:out.nonzero,total:out.total},null,1))
if (out.rows) console.log(out.rows.join('\n'))
console.log('--- console/page messages (' + msgs.length + ') ---')
console.log(msgs.slice(0,40).join('\n'))
await browser.close()
