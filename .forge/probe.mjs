import fs from 'node:fs'
import { PNG } from 'pngjs'
import path from 'node:path'
function loadPng(p){ return PNG.sync.read(fs.readFileSync(p)) }
function rgbToHsv(r,g,b){
  r/=255;g/=255;b/=255
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn
  let h=0
  if(d>1e-6){ if(mx===r)h=((g-b)/d+6)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60 }
  return {h, s: mx<1e-6?0:d/mx, v: mx}
}
const luma=(r,g,b)=>(0.2126*r+0.7152*g+0.0722*b)/255
export function patch(img, x, y, w=16, h=16){
  let r=0,g=0,b=0,n=0
  for(let j=y;j<y+h;j++) for(let i=x;i<x+w;i++){
    if(i<0||j<0||i>=img.width||j>=img.height) continue
    const k=(j*img.width+i)*4
    r+=img.data[k];g+=img.data[k+1];b+=img.data[k+2];n++
  }
  r/=n;g/=n;b/=n
  const {h:hh,s,v}=rgbToHsv(r,g,b)
  return {rgb:[Math.round(r),Math.round(g),Math.round(b)], hex:'#'+[r,g,b].map(c=>Math.round(c).toString(16).padStart(2,'0')).join(''), h:+hh.toFixed(0), s:+s.toFixed(3), v:+v.toFixed(3), luma:+luma(r,g,b).toFixed(3)}
}
export function sdLuma(img,x,y,w=20,h=20){
  const vals=[]
  for(let j=y;j<y+h;j++) for(let i=x;i<x+w;i++){
    if(i<0||j<0||i>=img.width||j>=img.height) continue
    const k=(j*img.width+i)*4
    vals.push(luma(img.data[k],img.data[k+1],img.data[k+2]))
  }
  const m=vals.reduce((a,b)=>a+b,0)/vals.length
  return {mean:+m.toFixed(3), sd:+Math.sqrt(vals.reduce((a,b)=>a+(b-m)**2,0)/vals.length).toFixed(4), min:+Math.min(...vals).toFixed(3), max:+Math.max(...vals).toFixed(3)}
}
export { loadPng }
if (process.argv[2]) {
  const img = loadPng(process.argv[2])
  console.log(`${process.argv[2]}  ${img.width}x${img.height}`)
  for (const spec of process.argv.slice(3)) {
    const [x,y,w,h] = spec.split(',').map(Number)
    const p = patch(img,x,y,w||16,h||16)
    const s = sdLuma(img,x,y,w||16,h||16)
    console.log(`  (${x},${y},${w||16}x${h||16}) ${p.hex} rgb(${p.rgb}) H${p.h} S${p.s} V${p.v} luma${p.luma}  sd ${s.sd} [${s.min}..${s.max}]`)
  }
}
