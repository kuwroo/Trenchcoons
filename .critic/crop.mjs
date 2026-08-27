import {load} from '/Users/chloeongsiyi/Trenchcoons/.critic/probe.mjs';
import {PNG} from '/Users/chloeongsiyi/Trenchcoons/node_modules/pngjs/lib/png.js';
import fs from 'fs';
const [src,out,x0,y0,w,h,scale]=process.argv.slice(2);
const im=load(src); const X=+x0,Y=+y0,W=+w,H=+h,S=+(scale??2);
const o=new PNG({width:W*S,height:H*S});
for(let y=0;y<H*S;y++)for(let x=0;x<W*S;x++){
  const sx=X+Math.floor(x/S), sy=Y+Math.floor(y/S);
  const i=(im.width*sy+sx)<<2, j=(o.width*y+x)<<2;
  o.data[j]=im.data[i];o.data[j+1]=im.data[i+1];o.data[j+2]=im.data[i+2];o.data[j+3]=255;}
fs.writeFileSync(out,PNG.sync.write(o));
