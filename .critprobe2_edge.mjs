import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {PNG} from 'pngjs'
function load(f){let p=f;if(!f.toLowerCase().endsWith('.png')){p='/tmp/crit2/'+path.basename(f).replace(/\.\w+$/,'')+'.png';execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(p))}
// analyse band [yFrac0,yFrac1)
function band(f,y0f,y1f){
  const png=load(f); const {width:W,height:H,data}=png
  const lum=new Float32Array(W*H)
  for(let i=0,p=0;i<data.length;i+=4,p++) lum[p]=(0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2])/255
  const y0=Math.max(1,Math.floor(H*y0f)), y1=Math.min(H-1,Math.floor(H*y1f))
  const grads=[]
  let e06=0,e12=0,e20=0,n=0
  for(let y=y0;y<y1;y++)for(let x=1;x<W-1;x++){
    const gx=lum[y*W+x+1]-lum[y*W+x-1], gy=lum[(y+1)*W+x]-lum[(y-1)*W+x]
    const g=Math.hypot(gx,gy); grads.push(g); n++
    if(g>0.06)e06++; if(g>0.12)e12++; if(g>0.20)e20++
  }
  grads.sort((a,b)=>a-b)
  const q=p=>grads[Math.floor(grads.length*p)]
  // plateau: fraction of pixels whose 5x5 neighbourhood spans < 0.010 luma
  let flat=0,fn=0
  for(let y=y0+2;y<y1-2;y+=2)for(let x=2;x<W-2;x+=2){
    let mn=1,mx=0
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const v=lum[(y+dy)*W+x+dx];if(v<mn)mn=v;if(v>mx)mx=v}
    fn++; if(mx-mn<0.010)flat++
  }
  return {file:path.basename(f),med:+q(0.5).toFixed(4),p90:+q(0.9).toFixed(4),p99:+q(0.99).toFixed(4),
    e06:+(100*e06/n).toFixed(2),e12:+(100*e12/n).toFixed(2),e20:+(100*e20/n).toFixed(2),
    plateauPct:+(100*flat/fn).toFixed(1)}
}
const [y0f,y1f]=[+process.argv[2],+process.argv[3]]
for(const f of process.argv.slice(4)){
  const r=band(f,y0f,y1f)
  console.log(r.file.padEnd(36),'med',String(r.med).padStart(7),'p90',String(r.p90).padStart(7),'p99',String(r.p99).padStart(7),
    '>.06%',String(r.e06).padStart(6),'>.12%',String(r.e12).padStart(6),'>.20%',String(r.e20).padStart(6),'plateau%',String(r.plateauPct).padStart(6))
}
