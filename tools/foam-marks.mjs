// Per-mark foam shape, for the ring-vs-lump question.
//
// `npm run water` measures the wake as a whole (`hull`, `fill`, `holes`). This
// reports each connected foam component separately — bbox, bbox fill, and a
// `2A/P` stroke width — because "is each white mark a ring or a filled blob" is
// a per-mark question and a whole-frame metric cannot answer it.
//
// READ bboxFill WITH CARE: it is confounded by the mark's ORIENTATION. A
// diagonal ribbon leaves most of its bounding box empty for purely geometric
// reasons, so our diagonal wake chain scores 0.09 against the reference's 0.36
// on a chain that runs along its box. Compare isolated, roughly round marks.
//
//   node tools/foam-marks.mjs shots/water-wake.png refs/water/shore-foam-wake.jpg
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/trench-water'; fs.mkdirSync(TMP,{recursive:true})
function loadPng(file){let q=file;if(!file.toLowerCase().endsWith('.png')){q=path.join(TMP,path.basename(file).replace(/\.\w+$/,'')+'.marks.png');execFileSync('sips',['-s','format','png',file,'--out',q],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(q))}
const foam = (p, i) => {
  const r = p.data[i], g = p.data[i+1], b = p.data[i+2]
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b)
  const s = mx ? (mx-mn)/mx : 0
  return s < 0.10 && mx > 217
}
for (const name of process.argv.slice(2)) {
  const p = loadPng(name)
  const w = p.width, h = p.height
  const seen = new Uint8Array(w*h)
  const comps = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y*w+x
    if (seen[k] || !foam(p, k*4)) continue
    let qs = [k]; seen[k] = 1
    let n = 0, x0=x, x1=x, y0=y, y1=y, per = 0
    while (qs.length) {
      const nq = []
      for (const c of qs) {
        n++
        const cx = c % w, cy = (c - cx) / w
        if (cx<x0)x0=cx; if(cx>x1)x1=cx; if(cy<y0)y0=cy; if(cy>y1)y1=cy
        let edge = false
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx+dx, ny = cy+dy
          if (nx<0||ny<0||nx>=w||ny>=h) { edge = true; continue }
          const nk = ny*w+nx
          if (!foam(p, nk*4)) { edge = true; continue }
          if (!seen[nk]) { seen[nk]=1; nq.push(nk) }
        }
        if (edge) per++
      }
      qs = nq
    }
    if (n > 200) comps.push({ n, bw: x1-x0+1, bh: y1-y0+1, per, x0, y0 })
  }
  comps.sort((a,b)=>b.n-a.n)
  console.log('\n' + name)
  for (const c of comps.slice(0,4)) {
    const bboxFill = c.n / (c.bw*c.bh)
    const stroke = 2*c.n/Math.max(1,c.per)
    console.log(`  ${String(c.bw)}x${c.bh} at ${c.x0},${c.y0}  px ${c.n}`
      + `  bboxFill ${bboxFill.toFixed(2)}`
      + `  stroke ${stroke.toFixed(1)}px  stroke/bboxMax ${(stroke/Math.max(c.bw,c.bh)).toFixed(3)}`)
  }
}
