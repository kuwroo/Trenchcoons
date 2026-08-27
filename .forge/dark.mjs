import fs from 'node:fs'
import { PNG } from 'pngjs'
const luma=(r,g,b)=>(0.2126*r+0.7152*g+0.0722*b)/255
function hsv(r,g,b){r/=255;g/=255;b/=255
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0
  if(d>1e-6){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}
  return [h, mx<1e-6?0:d/mx, mx]}
const img = PNG.sync.read(fs.readFileSync(process.argv[2]))
const cells=new Map()
for(let y=Math.floor(img.height*0.22);y<img.height;y++) for(let x=0;x<img.width;x++){
  const k=(y*img.width+x)*4
  const r=img.data[k],g=img.data[k+1],b=img.data[k+2]
  const [h,s]=hsv(r,g,b)
  if(h>=170&&h<=250&&s<0.5&&b>g && luma(r,g,b)<0.3){
    const key=`${Math.floor(x/100)*100},${Math.floor(y/100)*100}`
    cells.set(key,(cells.get(key)??0)+1)
  }
}
const top=[...cells].sort((a,b)=>b[1]-a[1]).slice(0,8)
console.log(process.argv[2], top.map(([k,v])=>`${k}:${v}`).join('  '))
