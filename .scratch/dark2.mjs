import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {PNG} from 'pngjs'
const TMP='/tmp/tc/png';fs.mkdirSync(TMP,{recursive:true})
function load(f){let p=f;if(!f.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(f).replace(/\.\w+$/,'')+'.png');execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(p))}
for(const f of process.argv.slice(2)){
 const png=load(f);const px=[]
 for(let i=0;i<png.data.length;i+=4){const r=png.data[i],g=png.data[i+1],b=png.data[i+2]
  px.push([r,g,b,(Math.max(r,g,b)+Math.min(r,g,b))/2/255])}
 px.sort((a,b)=>a[3]-b[3])
 const q=(lo,hi)=>{const s=px.slice(Math.floor(px.length*lo),Math.floor(px.length*hi))
  const m=s.reduce((a,p)=>[a[0]+p[0]/s.length,a[1]+p[1]/s.length,a[2]+p[2]/s.length],[0,0,0])
  const [r,g,b]=m.map(Math.round); const mx=Math.max(r,g,b),mn=Math.min(r,g,b)
  let h=0;const d=mx-mn
  if(d){if(mx===r)h=((g-b)/d+(g<b?6:0));else if(mx===g)h=((b-r)/d+2);else h=((r-g)/d+4);h*=60}
  return `rgb(${r},${g},${b}) h=${Math.round(h)} g/peak=${(g/Math.max(mx,1)).toFixed(2)} L=${((mx+mn)/2/255).toFixed(3)}`}
 console.log(path.basename(f).padEnd(28),'p0-2:',q(0,0.02),' p2-10:',q(0.02,0.10),' p10-20:',q(0.10,0.20))
}
