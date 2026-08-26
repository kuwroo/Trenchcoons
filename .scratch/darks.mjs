import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/tc/png'; fs.mkdirSync(TMP,{recursive:true})
function load(file){let p=file; if(!file.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(file).replace(/\.\w+$/,'')+'.png'); execFileSync('sips',['-s','format','png',file,'--out',p],{stdio:'ignore'})} return PNG.sync.read(fs.readFileSync(p))}
const files = process.argv.slice(2)
console.log('file'.padEnd(36),'minL   p001   %<.25  %<.35  %<.45   v05   medL  peak/lum(dark)')
for(const f of files){
  const png=load(f); const L=[]; let d25=0,d35=0,d45=0; const vals=[]
  let pr=0,pg=0,pb=0,pn=0
  for(let i=0;i<png.data.length;i+=4){
    const r=png.data[i]/255,g=png.data[i+1]/255,b=png.data[i+2]/255
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2
    L.push(l); vals.push(mx)
    if(l<0.25)d25++; if(l<0.35)d35++; if(l<0.45)d45++
    if(l<0.35){pr+=r;pg+=g;pb+=b;pn++}
  }
  L.sort((a,b)=>a-b); vals.sort((a,b)=>a-b)
  const n=L.length
  const lum=0.2126*pr/pn+0.7152*pg/pn+0.0722*pb/pn
  const peak=Math.max(pr,pg,pb)/pn
  console.log(path.basename(f).padEnd(36),
    L[0].toFixed(3), L[Math.floor(n*0.001)].toFixed(3),
    (100*d25/n).toFixed(2).padStart(6),(100*d35/n).toFixed(2).padStart(6),(100*d45/n).toFixed(2).padStart(6),
    vals[Math.floor(n*0.05)].toFixed(3).padStart(6), L[Math.floor(n*0.5)].toFixed(3).padStart(6),
    pn? (peak/Math.max(lum,1e-4)).toFixed(2):'-')
}
