import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {PNG} from 'pngjs'
function load(f){let p=f;if(!f.toLowerCase().endsWith('.png')){p='/tmp/crit2/'+path.basename(f).replace(/\.\w+$/,'')+'.png';execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(p))}
const f=process.argv[2], yf=+process.argv[3], x0=+process.argv[4], n=+process.argv[5]
const png=load(f);const{width:W,height:H,data}=png
const y=Math.floor(H*yf)
let s=''
for(let x=x0;x<x0+n;x++){const i=(y*W+x)*4;const l=(0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2])/255;s+=l.toFixed(3)+' '}
console.log(path.basename(f),'row',y)
console.log(s)
// run-length of "flat to 0.006"
let runs=[],cur=1,prev=null
for(let x=x0;x<x0+n;x++){const i=(y*W+x)*4;const l=(0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2])/255
  if(prev!==null){if(Math.abs(l-prev)<0.006)cur++;else{runs.push(cur);cur=1}}
  prev=l}
runs.push(cur)
runs.sort((a,b)=>b-a)
console.log('longest flat(<0.006/px) runs:',runs.slice(0,10).join(','),' mean',(runs.reduce((a,b)=>a+b,0)/runs.length).toFixed(2))
