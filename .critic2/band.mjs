import {PNG} from 'pngjs'; import fs from 'fs'
const [f,x0,y0,x1,y1,mode]=process.argv.slice(2)
const p=PNG.sync.read(fs.readFileSync(f))
const at=(x,y)=>{const i=(y*p.width+x)*4;return [p.data[i],p.data[i+1],p.data[i+2]]}
const lum=c=>(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255
const hsv=([r,g,b])=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}return[h,mx?d/mx:0,mx]}
const v=[]
for(let y=+y0;y<+y1;y++)for(let x=+x0;x<+x1;x++){const c=at(x,y);const [h,s]=hsv(c)
 const ok = mode==='green' ? (c[1]>c[0]+15 && h>110 && h<200) : (s<0.62)
 if(ok) v.push(lum(c))}
v.sort((a,b)=>a-b); const q=t=>v[Math.floor(t*(v.length-1))]
console.log(`${f} [${x0},${y0}-${x1},${y1}] n=${v.length} p02 ${q(.02).toFixed(3)} p10 ${q(.1).toFixed(3)} p50 ${q(.5).toFixed(3)} p90 ${q(.9).toFixed(3)} p98 ${q(.98).toFixed(3)} spread(p02-p98) ${(q(.98)-q(.02)).toFixed(3)}`)
