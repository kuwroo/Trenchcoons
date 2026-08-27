import fs from 'node:fs'
import { PNG } from 'pngjs'
const load = p => PNG.sync.read(fs.readFileSync(p))
const L=(p,x,y)=>{const i=(p.width*y+x)<<2;return 0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2]}
const F=load('shots/tracks-fresh.png')
// cross profile at row 860 around left mark x=582 and right x=1010
for (const [name,cx] of [['left',585],['right',1012]]) {
  const row=860, vals=[]
  for(let x=cx-40;x<=cx+40;x++) vals.push(Math.round(L(F,x,row)))
  console.log(name, vals.join(' '))
}
// local mottle: std of luminance in bare sand patches at row 860 (x 200-450, 1200-1450)
for(const [a,b] of [[200,450],[1200,1450]]){
  let s=0,s2=0,n=0
  for(let y=840;y<880;y++) for(let x=a;x<b;x++){const v=L(F,x,y);s+=v;s2+=v*v;n++}
  const m=s/n; console.log('bare',a,b,'mean',m.toFixed(1),'std',Math.sqrt(s2/n-m*m).toFixed(1))
}
