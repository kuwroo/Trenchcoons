import {PNG} from 'pngjs'; import fs from 'fs'
for(const f of process.argv.slice(2)){
 const p=PNG.sync.read(fs.readFileSync(f))
 const at=(x,y)=>{const i=(y*p.width+x)*4;return [p.data[i],p.data[i+1],p.data[i+2]]}
 const lum=c=>(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255
 const v=[]
 // rock = blue >= green (stone/massif render cyan-blue); exclude sky (top band is also blue) by requiring not-sky:
 // sky in these sheets is a smooth blue-violet gradient with r>=g; rock has g>r.
 for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){const c=at(x,y)
   if(c[2]>=c[1]-2 && c[1]>c[0]+4 && c[1]>60) v.push(lum(c))}
 v.sort((a,b)=>a-b); const q=t=>v[Math.floor(t*(v.length-1))]
 if(!v.length){console.log(f,'no pixels');continue}
 console.log(`${f.split('/').pop().padEnd(34)} n=${String(v.length).padStart(7)} p02 ${q(.02).toFixed(3)} p25 ${q(.25).toFixed(3)} p50 ${q(.5).toFixed(3)} p90 ${q(.9).toFixed(3)} p98 ${q(.98).toFixed(3)} spread ${(q(.98)-q(.02)).toFixed(3)}`)
}
