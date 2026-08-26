import fs from 'node:fs'; import { PNG } from 'pngjs'
function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn
  let h=0;if(d){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}
  return [h,mx?d/mx:0,mx]}
for(const f of process.argv.slice(2)){
  const p=PNG.sync.read(fs.readFileSync(f)); const {width:w,height:h,data:d}=p
  // find horizon: first row (top->down) where median V drops sharply
  let prev=null, hz=null
  const medV=[]
  for(let y=0;y<h;y+=2){const px=[]
    for(let x=Math.round(w*0.1);x<w*0.9;x+=9){const i=(y*w+x)*4;px.push(Math.max(d[i],d[i+1],d[i+2]))}
    px.sort((a,b)=>a-b); medV.push([y,px[Math.floor(px.length/2)]])}
  for(let k=6;k<medV.length;k++){ if(medV[k][1] < medV[k-6][1]-28){hz=medV[k][0];break} }
  console.log(`\n=== ${f}  horizon row ~${hz ?? '?'} of ${h} (${hz!=null?(hz/h).toFixed(2):'-'})`)
  if(hz==null) continue
  for(const off of [-60,-40,-20,-8,4,16]){
    const y=Math.max(0,Math.min(h-1,hz+off)); const px=[]
    for(let x=Math.round(w*0.1);x<w*0.9;x+=5){const i=(y*w+x)*4;px.push([d[i],d[i+1],d[i+2]])}
    px.sort((a,b)=>(a[0]+a[1]+a[2])-(b[0]+b[1]+b[2]))
    const [r,g,b]=px[Math.floor(px.length/2)]; const [hh,ss,vv]=hsv(r,g,b)
    console.log(`  hz${off>0?'+':''}${off}px  #${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}  hue ${hh.toFixed(0).padStart(4)}  S ${ss.toFixed(3)}  V ${vv.toFixed(3)}`)
  }
}
