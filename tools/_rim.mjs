import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/trench-water'; fs.mkdirSync(TMP,{recursive:true})
function load(f){let q=f;if(!f.toLowerCase().endsWith('.png')){q=path.join(TMP,path.basename(f).replace(/\.\w+$/,'')+'.rim.png');execFileSync('sips',['-s','format','png',f,'--out',q],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(q))}
const hsv=(r,g,b)=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h=0;const d=mx-mn;if(d){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}return[(h+360)%360,mx?d/mx:0,mx]}
// rim core = top 2% of luma inside the box; interior = 25th..55th percentile
function job(file, box, label){
  const p=load(file)
  const X0=Math.round(box[0]*p.width),Y0=Math.round(box[1]*p.height),X1=Math.round(box[2]*p.width),Y1=Math.round(box[3]*p.height)
  const px=[]
  for(let y=Y0;y<Y1;y++)for(let x=X0;x<X1;x++){const o=(y*p.width+x)*4
    const l=(0.2126*p.data[o]+0.7152*p.data[o+1]+0.0722*p.data[o+2])/255
    px.push([l,p.data[o],p.data[o+1],p.data[o+2]])}
  px.sort((a,b)=>a[0]-b[0])
  const mean=(arr)=>{let r=0,g=0,b=0;for(const q of arr){r+=q[1];g+=q[2];b+=q[3]}const n=arr.length;return [r/n,g/n,b/n]}
  const rim=mean(px.slice(Math.floor(px.length*0.98)))
  const inter=mean(px.slice(Math.floor(px.length*0.25),Math.floor(px.length*0.55)))
  const [rh,rs,rv]=hsv(...rim), [ih,is,iv]=hsv(...inter)
  let dh=rh-ih; if(dh>180)dh-=360; if(dh<-180)dh+=360
  console.log(`${label.padEnd(24)} rim H${rh.toFixed(0)} S${rs.toFixed(2)} V${rv.toFixed(2)}`
    + `  interior H${ih.toFixed(0)} S${is.toFixed(2)} V${iv.toFixed(2)}`
    + `  dH ${dh>=0?'+':''}${dh.toFixed(0)}  dS ${(rs-is).toFixed(2)}  V x${(rv/iv).toFixed(2)}`)
}
job('refs/water/lake-cartoon-cells.jpg',[0.234,0.36,0.586,0.483],'REF lake')
job('shots/water-close.png',[0.10,0.45,0.90,0.90],'ours water-close')
job('shots/water-open.png',[0.20,0.50,0.80,0.70],'ours water-open')
