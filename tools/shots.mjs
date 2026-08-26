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

// Two camera registers, and both are required.
//
// VISTA (y=180) is what judges atmosphere: layered receding hills for aerial
// perspective to eat, a horizon, sky.
//
// GROUND (y=3.5) is what judges the MATERIAL, and round 1 had none of it. Every
// shot was a vista, so the nearest ground was ~260m out, the fine brush octave
// was mathematically zero in all eight PNGs, and near-field albedo — the one
// place haze is ~0 and the palette should be at full chroma — was never
// captured. This is a driving game; y=3.5 is the camera the player actually has.
const VISTA = 'pos=0,180,700&warmup=64'
const GROUND = 'pos=280,14,760&warmup=64'

export const SHOTS = [
  // Fixed vista camera, varying time. Five sun elevations, not four: with the
  // dusk declination in sunDirection() the arc is asymmetric, so 0.25 and 0.75
  // are genuinely different. The five elevations are 0, 34, 59, 22 and 7 deg.
  { name: 'greybox-morning',   q: `time=0.36&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-sunrise',   q: `time=0.25&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-noon',      q: `time=0.50&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-afternoon', q: `time=0.70&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-dusk',      q: `time=0.75&${VISTA}&look=0.42,-0.17` },

  // Sun-facing counterparts — where the scattering model actually shows. The
  // sunrise one is taken from the ground camera: a vista at the same hour and a
  // 51deg azimuth offset from the canonical shot was not a different picture
  // (mean abs diff 17.7), and `npm run distinct` says so.
  { name: 'atmos-sunrise-sunward', q: `time=0.25&${GROUND}&look=-0.471,-0.16` },
  { name: 'atmos-golden-sunward',  q: `time=0.72&${VISTA}&look=2.55,-0.06` },
  { name: 'atmos-dusk-sunward',    q: `time=0.75&${VISTA}&look=2.671,-0.06` },
  // Looking up: the only shot that judges cloud colour on its own terms.
  { name: 'atmos-clouds-noon',     q: `time=0.50&${VISTA}&look=0.6,0.34` },

  // Gameplay height. Brush texture, near-field chroma, cast-shadow contact.
  { name: 'ground-morning', q: `time=0.36&${GROUND}&look=-1.15,-0.12` },
  { name: 'ground-noon',    q: `time=0.50&${GROUND}&look=-1.15,-0.12` },
  { name: 'ground-dusk',    q: `time=0.75&${GROUND}&look=-1.15,-0.12` },
  // The lagoon: turquoise + cream + lime in one frame, as cliffs-tohad.jpg does.
  { name: 'lagoon-morning', q: `time=0.36&pos=100,150,-560&warmup=64&look=0.885,-0.115` },
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
