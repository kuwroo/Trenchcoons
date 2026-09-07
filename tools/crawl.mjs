// Two-resolution crawl test — the one honest way to tell TEXTURE from ALIASING.
//
// `npm run water`'s `fine` metric measures high-frequency energy, and it cannot
// distinguish a cartoon's crisp detail from a shimmering edge: at a
// 0.4%-of-width window the two are the same measurement. That gap cost four
// consecutive "fixes" in this build, each of which measured as changing nothing
// because there was nothing there to fix, and two of which cost real texture.
//
// THE TEST. Render the same frame twice: once at the shipping resolution, and
// once at 2x and box-filtered down to it. Supersampling is a near-ground-truth
// antialias, so the two differ only by whatever the native render could not
// resolve. Genuine texture survives downsampling; aliasing does not.
//
//   ratio = fine(native) / fine(supersampled)
//
// A ratio near 1 means the native frame's high-frequency content is real. A
// large ratio means the native frame is carrying energy the supersampled one
// does not — i.e. it is inventing detail at the sampling limit, which is crawl.
//
// It also reports the reverse case: a ratio well UNDER 1 means the native render
// is LOSING texture the scene actually has, which is over-blurring.
//
//   node tools/crawl.mjs                      # all water frames
//   node tools/crawl.mjs water-close water-open
//
// Needs `vite preview` on BASE_URL, like tools/shots.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'

const OUT = '/tmp/trench-crawl'
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4174'
const W = 1600
const H = 900
const SS = 2

/** Ceiling only. Above this the frame is inventing detail it cannot resolve. */
const RATIO = [0.55, 1.30]

function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file))
}

/** Box-filter an image down by an integer factor. */
function downsample(png, f) {
  const w = Math.floor(png.width / f), h = Math.floor(png.height / f)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const o = ((y * f + j) * png.width + (x * f + i)) * 4
          s += (0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2]) / 255
        }
      }
      out[y * w + x] = s / (f * f)
    }
  }
  return { w, h, lum: out }
}

function luma(png) {
  const out = new Float64Array(png.width * png.height)
  for (let i = 0, n = png.width * png.height; i < n; i++) {
    const o = i * 4
    out[i] = (0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2]) / 255
  }
  return { w: png.width, h: png.height, lum: out }
}

/**
 * Residual after a small box blur — the same shape as `fine` in tools/water.mjs,
 * and deliberately measured over the WHOLE frame here. Restricting it to a box
 * would make this report how well the box was placed.
 */
function fine(img) {
  const { w, h, lum } = img
  const r = Math.max(1, Math.round(w * 0.002))
  let sum = 0, sum2 = 0, n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const yy = y + j, xx = x + i
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue
          s += lum[yy * w + xx]; c++
        }
      }
      const d = lum[y * w + x] - s / c
      sum += d; sum2 += d * d; n++
    }
  }
  const m = sum / n
  return Math.sqrt(sum2 / n - m * m)
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

async function main() {
  // IMPORTED, NOT RETYPED. `WEBGPU_ARGS` is platform-specific — on this machine
  // it is `--use-angle=metal`, and the Vulkan flags this file first used (copied
  // from memory rather than from the harness) leave the GPU context dead and
  // every capture uniformly rgb(11,13,16). Two tools in this session lost time
  // to exactly that before anyone read the harness.
  const { SHOTS, WEBGPU_ARGS } = await import('./shots.mjs')
  const { chromium } = await import('playwright')
  const list = SHOTS.filter((s) => s.name.startsWith('water-')
    && (!only.length || only.includes(s.name)))
  if (!list.length) { console.log('crawl — nothing selected'); process.exit(0) }
  await fs.promises.mkdir(OUT, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
  const page = await browser.newPage({ viewport: { width: W, height: H } })

  console.log('crawl — texture vs aliasing, native against 2x supersampled\n')
  let fail = 0
  for (const s of list) {
    // ONE PAGE, RESIZED — never a fresh page per capture. A newly created page
    // renders BLANK here: both captures came out uniformly rgb(11,13,16), which
    // is the background, and `fine` read exactly 0.0000 on each. `tools/shots.mjs`
    // creates a single page and reuses it for all 53 shots, and that is not
    // incidental. Same class as the other apparatus failures in CLAUDE.md.
    const shot = async (w, h, tag) => {
      const file = path.join(OUT, `${s.name}.${tag}.png`)
      await page.setViewportSize({ width: w, height: h })
      await page.goto(`${BASE}/?shot=1&${s.q}`, { waitUntil: 'load', timeout: 40_000 })
      await page.evaluate(() => window.__ready ?? Promise.reject(new Error('__ready missing')))
      await page.screenshot({ path: file })
      return file
    }
    try {
      const nat = loadPng(await shot(W, H, 'native'))
      const sup = loadPng(await shot(W * SS, H * SS, 'ss'))
      const fNat = fine(luma(nat))
      const fSup = fine(downsample(sup, SS))
      const ratio = fSup > 1e-9 ? fNat / fSup : 0
      const ok = ratio >= RATIO[0] && ratio <= RATIO[1]
      if (!ok) fail++
      console.log(`  ${ok ? ' ok ' : 'FAIL'} ${s.name.padEnd(20)}`
        + ` fine native ${fNat.toFixed(4)}  supersampled ${fSup.toFixed(4)}`
        + `  ratio ${ratio.toFixed(2)}${ok ? '' : '!'}`)
    } catch (e) {
      fail++
      console.log(`  FAIL ${s.name.padEnd(20)} ${String(e).split('\n')[0]}`)
    }
  }
  await browser.close()
  console.log(fail ? `\n${fail} frame(s) crawl` : '\ncrawl ok')
  process.exit(fail ? 1 : 0)
}
main()
