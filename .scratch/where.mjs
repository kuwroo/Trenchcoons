import fs from 'node:fs';import {PNG} from 'pngjs'
const f=process.argv[2]; const thr=Number(process.argv[3]??0.32)
const png=PNG.sync.read(fs.readFileSync(f))
const {width:W,height:H,data}=png
// 32x18 grid counts of pixels with HSL L below thr
const GX=32,GY=18; const cnt=new Array(GX*GY).fill(0)
let mn=1,mx=0,mi=0
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4
 const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255
 const l=(Math.max(r,g,b)+Math.min(r,g,b))/2
 if(l<mn){mn=l;mi=i}
 if(l<thr)cnt[Math.floor(y/H*GY)*GX+Math.floor(x/W*GX)]++
}
const cell=(W/GX)*(H/GY)
for(let gy=0;gy<GY;gy++){let s=''
 for(let gx=0;gx<GX;gx++){const p=cnt[gy*GX+gx]/cell
  s+= p>0.5?'#':p>0.2?'+':p>0.05?'.':p>0?',':' '}
 console.log(s)}
const y=Math.floor(mi/4/W),x=(mi/4)%W
console.log(`min L=${mn.toFixed(3)} at (${x},${y}) rgb(${data[mi]},${data[mi+1]},${data[mi+2]})`)
