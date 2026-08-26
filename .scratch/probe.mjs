import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {PNG} from 'pngjs'
const TMP='/tmp/tc/png';fs.mkdirSync(TMP,{recursive:true})
function load(f){let p=f;if(!f.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(f).replace(/\.\w+$/,'')+'.png');execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})}return PNG.sync.read(fs.readFileSync(p))}
const [file,...pts]=process.argv.slice(2)
const png=load(file);console.log(file,png.width+'x'+png.height)
for(const pt of pts){const [x,y]=pt.split(',').map(Number);const i=(y*png.width+x)*4
const r=png.data[i],g=png.data[i+1],b=png.data[i+2]
const mx=Math.max(r,g,b)/255,mn=Math.min(r,g,b)/255
console.log(`  (${x},${y}) rgb(${r},${g},${b}) L=${((mx+mn)/2).toFixed(3)} peak=${mx.toFixed(3)} luma=${((0.2126*r+0.7152*g+0.0722*b)/255).toFixed(3)}`)}
