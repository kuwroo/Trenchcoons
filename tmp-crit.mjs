import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/trench-crit'; fs.mkdirSync(TMP,{recursive:true})
function load(f){let p=f; if(!f.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(f).replace(/\.\w+$/,'')+'.png'); execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})} return PNG.sync.read(fs.readFileSync(p))}
const hsv=(r,g,b)=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d>0){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);if(h<0)h+=360}return[h,mx>0?d/mx:0,mx]}
const luma=(r,g,b)=>(0.2126*r+0.7152*g+0.0722*b)/255
const bx=(p,f)=>({x0:Math.round(f[0]*p.width),y0:Math.round(f[1]*p.height),x1:Math.round(f[2]*p.width),y1:Math.round(f[3]*p.height)})
function stats(p,f){const b=bx(p,f);let n=0,sx=0,sy=0,ss=0,sv=0,ls=[];for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++){const o=(y*p.width+x)*4;const[h,s,v]=hsv(p.data[o],p.data[o+1],p.data[o+2]);const a=h*Math.PI/180;sx+=Math.cos(a);sy+=Math.sin(a);ss+=s;sv+=v;ls.push(luma(p.data[o],p.data[o+1],p.data[o+2]));n++}
 let H=Math.atan2(sy/n,sx/n)*180/Math.PI; if(H<0)H+=360; ls.sort((a,b)=>a-b)
 const q=t=>ls[Math.round(t*(ls.length-1))]
 const mean=ls.reduce((a,b)=>a+b,0)/n; const sd=Math.sqrt(ls.reduce((a,b)=>a+(b-mean)**2,0)/n)
 return {H:+H.toFixed(1),S:+(ss/n).toFixed(3),V:+(sv/n).toFixed(3),L:+mean.toFixed(3),Lsd:+sd.toFixed(4),p05:+q(0.05).toFixed(3),p50:+q(0.5).toFixed(3),p95:+q(0.95).toFixed(3)}}
// coarse tone variation: blur to ~3% of width then std (large-scale patchiness)
function coarseSd(p,f,frac){const b=bx(p,f);const R=Math.max(1,Math.round(p.width*frac));const w=b.x1-b.x0,h=b.y1-b.y0
 const src=new Float64Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=((y+b.y0)*p.width+(x+b.x0))*4;src[y*w+x]=luma(p.data[o],p.data[o+1],p.data[o+2])}
 // separable box blur
 const t=new Float64Array(w*h),out=new Float64Array(w*h)
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0,n=0;for(let d=-R;d<=R;d++){const xx=x+d;if(xx<0||xx>=w)continue;s+=src[y*w+xx];n++}t[y*w+x]=s/n}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0,n=0;for(let d=-R;d<=R;d++){const yy=y+d;if(yy<0||yy>=h)continue;s+=t[yy*w+x];n++}out[y*w+x]=s/n}
 const m=out.reduce((a,b)=>a+b,0)/out.length
 const sd=Math.sqrt(out.reduce((a,b)=>a+(b-m)**2,0)/out.length)
 return {mean:+m.toFixed(3),sd:+sd.toFixed(4),rel:+(sd/m).toFixed(4)}}
const R='/Users/chloeongsiyi/Trenchcoons/refs/water/'; const S='/tmp/wsnap8/'
const lake=load(R+'lake-cartoon-cells.jpg'), shore=load(R+'shore-foam-wake.jpg')
console.log('dims lake',lake.width,lake.height,'shore',shore.width,shore.height)
console.log('--- DEEP / MASS COLOUR ---')
console.log('lake  deep [.36,.28,.56,.42] ',JSON.stringify(stats(lake,[0.36,0.28,0.56,0.42])))
console.log('lake  cells[.30,.20,.70,.55] ',JSON.stringify(stats(lake,[0.30,0.20,0.70,0.55])))
console.log('shore deep [.30,.02,.70,.12] ',JSON.stringify(stats(shore,[0.30,0.02,0.70,0.12])))
for(const[f,b,n] of [['water-close',[0.20,0.30,0.80,0.42],'deep'],['water-close',[0.10,0.45,0.90,0.90],'cells'],['water-open',[0.20,0.50,0.80,0.62],'deep'],['water-open',[0.20,0.50,0.80,0.70],'cells'],['water-bob',[0.05,0.55,0.35,0.95],'mass']]){
 const p=load(S+f+'.png'); console.log(f,n,JSON.stringify(stats(p,b)))}
console.log('--- COARSE PATCHINESS (blur 3% width, rel sd) ---')
console.log('lake  cells',JSON.stringify(coarseSd(lake,[0.30,0.20,0.70,0.55],0.03)))
console.log('close cells',JSON.stringify(coarseSd(load(S+'water-close.png'),[0.10,0.45,0.90,0.90],0.03)))
console.log('open  cells',JSON.stringify(coarseSd(load(S+'water-open.png'),[0.20,0.50,0.80,0.70],0.03)))
console.log('--- water-open AERIAL LADDER (cols .25-.75) ---')
const wo=load(S+'water-open.png')
for(const[y0,y1,n] of [[0.455,0.475,'far(just below horizon)'],[0.52,0.55,'d2'],[0.62,0.65,'d3'],[0.75,0.78,'d4'],[0.92,0.97,'near']]) console.log(n,JSON.stringify(stats(wo,[0.25,y0,0.75,y1])))
console.log('sky above horizon',JSON.stringify(stats(wo,[0.25,0.40,0.75,0.43])))
