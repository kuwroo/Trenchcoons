import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/crit-sky'; fs.mkdirSync(TMP,{recursive:true})
function loadPng(file){let p=file
  if(!file.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(file).replace(/\.\w+$/,'')+'.png')
    execFileSync('sips',['-s','format','png',file,'--out',p],{stdio:'ignore'})}
  return PNG.sync.read(fs.readFileSync(p))}
function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn
  let h=0;if(d){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}
  return [h,mx?d/mx:0,mx]}
for(const f of process.argv.slice(2)){
  const p=loadPng(f); const {width:w,height:h,data:d}=p
  console.log('\n=== '+f+`  ${w}x${h}`)
  console.log('  yFrac   hex      hue   S(hsv)   V')
  for(const yf of [0.00,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50]){
    const y=Math.min(h-1,Math.round(yf*h)); const px=[]
    for(let x=Math.round(w*0.05);x<w*0.95;x+=5){const i=(y*w+x)*4;px.push([d[i],d[i+1],d[i+2]])}
    px.sort((a,b)=>(a[0]+a[1]+a[2])-(b[0]+b[1]+b[2]))
    const [r,g,b]=px[Math.floor(px.length/2)]
    const [hh,ss,vv]=hsv(r,g,b)
    console.log(`  ${yf.toFixed(2)}  #${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}  ${hh.toFixed(0).padStart(4)}   ${ss.toFixed(3)}  ${vv.toFixed(3)}`)
  }
}
