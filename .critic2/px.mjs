import {PNG} from 'pngjs'; import fs from 'fs'
const f=process.argv[2]
const p=PNG.sync.read(fs.readFileSync(f))
const {width:W,height:H,data:D}=p
const at=(x,y)=>{const i=(y*W+x)*4;return [D[i],D[i+1],D[i+2]]}
const lum=([r,g,b])=>(0.2126*r+0.7152*g+0.0722*b)/255
const hex=([r,g,b])=>'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')
// classify: rock-ish = low sat, high value, not green-dominant
const hsv=([r,g,b])=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn
 let h=0; if(d){ if(mx===r)h=((g-b)/d+6)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60}
 return [h, mx?d/mx:0, mx]}
const args=process.argv.slice(3)
if(args[0]==='pt'){ for(let i=1;i<args.length;i+=2){const x=+args[i],y=+args[i+1];const c=at(x,y);const [h,s,v]=hsv(c);console.log(`(${x},${y}) ${hex(c)} H${h.toFixed(0)} S${s.toFixed(3)} V${v.toFixed(3)} luma ${lum(c).toFixed(3)}`)} }
else if(args[0]==='box'){ const [x0,y0,x1,y1]=args.slice(1).map(Number); let n=0,sl=0,sl2=0,sr=0,sg=0,sb=0
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const c=at(x,y);const l=lum(c);n++;sl+=l;sl2+=l*l;sr+=c[0];sg+=c[1];sb+=c[2]}
 const m=sl/n; const sd=Math.sqrt(sl2/n-m*m); const mc=[sr/n,sg/n,sb/n].map(Math.round); const [h,s,v]=hsv(mc)
 console.log(`box ${x0},${y0}-${x1},${y1} n=${n} mean ${hex(mc)} H${h.toFixed(0)} S${s.toFixed(3)} luma ${m.toFixed(3)} sd ${sd.toFixed(4)}`)}
else if(args[0]==='hist'){ // luma histogram of non-ground non-sky "subject": low-saturation pixels
 const vals=[]
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=at(x,y);const [h,s,v]=hsv(c); if(s<0.25&&v>0.2) vals.push(lum(c))}
 vals.sort((a,b)=>a-b); const q=p=>vals[Math.floor(p*(vals.length-1))]
 console.log(`lowSat px ${vals.length} p02 ${q(.02).toFixed(3)} p10 ${q(.10).toFixed(3)} p50 ${q(.5).toFixed(3)} p90 ${q(.9).toFixed(3)} p98 ${q(.98).toFixed(3)}`)}
