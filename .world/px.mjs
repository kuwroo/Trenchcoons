// Pixel probe. usage: node px.mjs file.png [x0,y0,x1,y1] ...
import fs from 'node:fs'
import { PNG } from 'pngjs'
import { execFileSync } from 'node:child_process'
function load(f) {
  if (f.endsWith('.png')) return PNG.sync.read(fs.readFileSync(f))
  const tmp = '/tmp/w-' + Math.random().toString(36).slice(2) + '.png'
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', f, '--out', tmp], { stdio: 'ignore' })
  return PNG.sync.read(fs.readFileSync(tmp))
}
function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  h *= 60; if (h < 0) h += 360
  return [h, mx > 0 ? d / mx : 0, mx]
}
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const file = process.argv[2]
const png = load(file)
const boxes = process.argv.slice(3)
const list = boxes.length ? boxes : [`0,${Math.floor(png.height / 2)},${png.width},${png.height}`]
console.log(`${file} ${png.width}x${png.height}`)
for (const spec of list) {
  const [x0, y0, x1, y1] = spec.split(',').map(Number)
  let n = 0, R = 0, G = 0, B = 0, S = 0, L = 0, hx = 0, hy = 0, lmin = 9, lmax = -9
  const lum = []
  for (let y = y0; y < Math.min(y1, png.height); y++) {
    for (let x = x0; x < Math.min(x1, png.width); x++) {
      const o = (y * png.width + x) * 4
      const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2]
      const [h, s, v] = hsv(r, g, b); const l = luma(r, g, b)
      n++; R += r; G += g; B += b; S += s; L += l
      hx += Math.cos(h * Math.PI / 180) * s; hy += Math.sin(h * Math.PI / 180) * s
      if (l < lmin) lmin = l; if (l > lmax) lmax = l
      lum.push(l)
    }
  }
  lum.sort((a, b) => a - b)
  let mh = Math.atan2(hy, hx) * 180 / Math.PI; if (mh < 0) mh += 360
  const hex = '#' + [R / n, G / n, B / n].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
  const sd = Math.sqrt(lum.reduce((a, v) => a + (v - L / n) ** 2, 0) / n)
  console.log(`  ${spec.padEnd(22)} n=${n} ${hex} rgb(${Math.round(R / n)},${Math.round(G / n)},${Math.round(B / n)}) H${mh.toFixed(0)} S${(S / n).toFixed(3)} luma${(L / n).toFixed(3)} sd${sd.toFixed(4)} p05..p95 ${lum[Math.floor(n * 0.05)].toFixed(3)}..${lum[Math.floor(n * 0.95)].toFixed(3)}`)
}
