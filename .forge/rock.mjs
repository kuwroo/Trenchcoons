// Rock facet value distribution in a forge sheet: the numbers the critic
// measured. Filters to rock-coloured pixels (cool hue, low-to-mid saturation)
// below the horizon band, and reports the value spread across facets.
import fs from 'node:fs'
import { PNG } from 'pngjs'
const luma=(r,g,b)=>(0.2126*r+0.7152*g+0.0722*b)/255
function hsv(r,g,b){r/=255;g/=255;b/=255
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0
  if(d>1e-6){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}
  return [h, mx<1e-6?0:d/mx, mx]}
for (const f of process.argv.slice(2)) {
  const img = PNG.sync.read(fs.readFileSync(f))
  const vals=[]
  const y0 = Math.floor(img.height*0.22)
  for(let y=y0;y<img.height;y++) for(let x=0;x<img.width;x++){
    const k=(y*img.width+x)*4
    const r=img.data[k],g=img.data[k+1],b=img.data[k+2]
    const [h,s]=hsv(r,g,b)
    if(h>=170&&h<=250&&s<0.5&&b>g) vals.push(luma(r,g,b))
  }
  vals.sort((a,b)=>a-b)
  const q=p=>vals.length?vals[Math.floor(p*(vals.length-1))].toFixed(3):'-'
  console.log(`${f.split('/').pop().padEnd(30)} n=${String(vals.length).padStart(7)}  p02 ${q(0.02)}  p10 ${q(0.10)}  p50 ${q(0.5)}  p90 ${q(0.9)}  share ${(100*vals.length/(img.width*img.height*0.78)).toFixed(2)}%`)
}
