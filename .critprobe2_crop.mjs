import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {PNG} from 'pngjs'
const [src,x0,y0,w,h,out,scaleArg] = process.argv.slice(2)
let p = src
if(!src.toLowerCase().endsWith('.png')){p='/tmp/crit2/'+path.basename(src).replace(/\.\w+$/,'')+'.png';fs.mkdirSync('/tmp/crit2',{recursive:true});execFileSync('sips',['-s','format','png',src,'--out',p],{stdio:'ignore'})}
const png=PNG.sync.read(fs.readFileSync(p))
const X=+x0,Y=+y0,W=+w,H=+h,S=scaleArg?+scaleArg:1
const o=new PNG({width:W*S,height:H*S})
for(let y=0;y<H*S;y++)for(let x=0;x<W*S;x++){
  const sx=X+Math.floor(x/S), sy=Y+Math.floor(y/S)
  const si=(sy*png.width+sx)*4, di=(y*(W*S)+x)*4
  o.data[di]=png.data[si];o.data[di+1]=png.data[si+1];o.data[di+2]=png.data[si+2];o.data[di+3]=255
}
fs.writeFileSync(out,PNG.sync.write(o))
console.log('wrote',out,W*S+'x'+H*S)
