import fs from 'node:fs';import {PNG} from 'pngjs'
const f=process.argv[2]
const png=PNG.sync.read(fs.readFileSync(f));const {width:W,height:H,data}=png
const lum=new Float32Array(W*H)
for(let i=0,p=0;i<data.length;i+=4,p++)lum[p]=(0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2])/255
const s=[...lum].sort((a,b)=>a-b); const thr=s[Math.floor(s.length*0.2)]
const GX=40,GY=20; const cnt=new Array(GX*GY).fill(0)
for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(lum[y*W+x]<=thr) cnt[Math.floor(y/H*GY)*GX+Math.floor(x/W*GX)]++
const cell=(W/GX)*(H/GY)
for(let gy=0;gy<GY;gy++){let r=''
 for(let gx=0;gx<GX;gx++){const p=cnt[gy*GX+gx]/cell; r+= p>0.8?'#':p>0.5?'+':p>0.2?'.':p>0.02?',':' '}
 console.log(r)}
console.log('darkest-20% threshold luma',thr.toFixed(3),' mean',(s.slice(0,Math.floor(s.length*0.2)).reduce((a,b)=>a+b,0)/Math.floor(s.length*0.2)).toFixed(3))
