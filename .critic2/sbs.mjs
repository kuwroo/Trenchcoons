import {PNG} from 'pngjs'; import fs from 'fs'
const R=PNG.sync.read(fs.readFileSync('.critic/ref.png'))
const B=PNG.sync.read(fs.readFileSync('shots/forge/forge-close-boulder-large.png'))
const C=PNG.sync.read(fs.readFileSync('shots/forge/forge-close-outcrop-shelf.png'))
const W=1240,H=430
const out=new PNG({width:W,height:H})
const cp=(S,sx,sy,sw,sh,dx,dy)=>{for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
 const yy=sy+y,xx=sx+x; if(yy<0||xx<0||yy>=S.height||xx>=S.width)continue
 const si=(yy*S.width+xx)*4, di=((dy+y)*W+(dx+x))*4
 out.data[di]=S.data[si];out.data[di+1]=S.data[si+1];out.data[di+2]=S.data[si+2];out.data[di+3]=255}}
// reference: right cliff, 410x410
cp(R,760,200,410,410,0,10)
// built boulder-large close-up, downscaled 2x from 820x820
const dn=(S,sx,sy,sw,f,dx,dy)=>{for(let y=0;y<sw/f;y++)for(let x=0;x<sw/f;x++){
 const si=((sy+y*f)*S.width+(sx+x*f))*4, di=((dy+y)*W+(dx+x))*4
 out.data[di]=S.data[si];out.data[di+1]=S.data[si+1];out.data[di+2]=S.data[si+2];out.data[di+3]=255}}
dn(B,390,80,820,2,420,10)
dn(C,290,60,820,2,830,10)
fs.writeFileSync('.critic2/sbs.png',PNG.sync.write(out))
console.log('ok')
