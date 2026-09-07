import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process'
import { PNG } from 'pngjs'
const TMP='/tmp/trench-crit'; fs.mkdirSync(TMP,{recursive:true})
function load(f){let p=f; if(!f.toLowerCase().endsWith('.png')){p=path.join(TMP,path.basename(f).replace(/\.\w+$/,'')+'.png'); execFileSync('sips',['-s','format','png',f,'--out',p],{stdio:'ignore'})} return PNG.sync.read(fs.readFileSync(p))}
const hsv=(r,g,b)=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d>0){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);if(h<0)h+=360}return[h,mx>0?d/mx:0,mx]}
const luma=(r,g,b)=>(0.2126*r+0.7152*g+0.0722*b)/255
const bx=(p,f)=>({x0:Math.round(f[0]*p.width),y0:Math.round(f[1]*p.height),x1:Math.round(f[2]*p.width),y1:Math.round(f[3]*p.height)})
function grab(p,f){const b=bx(p,f),w=b.x1-b.x0,h=b.y1-b.y0,L=new Float64Array(w*h)
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=((y+b.y0)*p.width+(x+b.x0))*4;L[y*w+x]=luma(p.data[o],p.data[o+1],p.data[o+2])}
 return {L,w,h,W:p.width}}
function blur(L,w,h,R){const t=new Float64Array(w*h),o=new Float64Array(w*h)
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0,n=0;for(let d=-R;d<=R;d++){const xx=x+d;if(xx<0||xx>=w)continue;s+=L[y*w+xx];n++}t[y*w+x]=s/n}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0,n=0;for(let d=-R;d<=R;d++){const yy=y+d;if(yy<0||yy>=h)continue;s+=t[yy*w+x];n++}o[y*w+x]=s/n}
 return o}
// cell interiors = pixels DARKER than local mean; label 4-connected
function cellStats(file,f,label){
 const p=load(file); const {L,w,h,W}=grab(p,f)
 const bl=blur(L,w,h,Math.max(2,Math.round(W*0.02)))
 const interior=new Uint8Array(w*h); let rim=0
 for(let i=0;i<w*h;i++){ if(L[i] < bl[i]-0.004) interior[i]=1; else rim++ }
 const lab=new Int32Array(w*h).fill(-1); const comps=[]
 for(let i=0;i<w*h;i++){ if(!interior[i]||lab[i]>=0) continue
  const q=[i]; lab[i]=comps.length; let a=0,per=0
  while(q.length){const c=q.pop(); a++; const x=c%w,y=(c-x)/w
   const nb=[[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
   for(const[nx,ny] of nb){ if(nx<0||ny<0||nx>=w||ny>=h){per++;continue}
    const j=ny*w+nx; if(!interior[j]){per++;continue} if(lab[j]<0){lab[j]=comps.length;q.push(j)} } }
  comps.push({a,per}) }
 const big=comps.filter(c=>c.a>=(W*0.008)**2).sort((x,y)=>y.a-x.a)
 const areas=big.map(c=>c.a)
 const med=areas.length?areas[Math.floor(areas.length/2)]:0
 const cellsPerW = med? W/Math.sqrt(med) : 0
 const circ=big.map(c=>4*Math.PI*c.a/(c.per*c.per))
 const mc=circ.length? circ.reduce((a,b)=>a+b,0)/circ.length : 0
 console.log(label.padEnd(22), 'rimFrac',(rim/(w*h)).toFixed(3), 'cells',big.length,
  'medArea',med, 'cellsPerFrameW',cellsPerW.toFixed(1), 'meanCirc',mc.toFixed(3),
  'p10circ',circ.length?circ.sort((a,b)=>a-b)[Math.floor(circ.length*0.1)].toFixed(3):'-')
}
const R='/Users/chloeongsiyi/Trenchcoons/refs/water/', S='/tmp/wsnap8/'
console.log('=== CELL GEOMETRY (interior components, local-mean rim) ===')
cellStats(R+'lake-cartoon-cells.jpg',[0.30,0.20,0.70,0.55],'REF lake cells')
cellStats(S+'water-close.png',[0.10,0.45,0.90,0.90],'water-close cells')
cellStats(S+'water-open.png',[0.20,0.50,0.80,0.70],'water-open cells')
cellStats(S+'water-bob.png',[0.05,0.35,0.45,0.90],'water-bob left')
console.log('=== SWASH MOTION box[0,.42,.60,.78] ===')
let prev=null
for(let i=0;i<6;i++){const p=load(S+`water-swash-${i}.png`);const b=bx(p,[0,0.42,0.60,0.78])
 let foam=0,n=0,top=1e9,sy=0; const mask=[]
 for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++){const o=(y*p.width+x)*4;const[,s,v]=hsv(p.data[o],p.data[o+1],p.data[o+2]);const f=(s<0.15&&v>0.85);if(f){foam++;sy+=y;if(y<top)top=y}n++}
 // perimeter of foam mask for stroke
 let per=0
 for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++){const o=(y*p.width+x)*4;const[,s,v]=hsv(p.data[o],p.data[o+1],p.data[o+2]);if(!(s<0.15&&v>0.85))continue
  for(const[dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy;if(xx<b.x0||yy<b.y0||xx>=b.x1||yy>=b.y1){per++;continue}const q=(yy*p.width+xx)*4;const[,s2,v2]=hsv(p.data[q],p.data[q+1],p.data[q+2]);if(!(s2<0.15&&v2>0.85))per++}}
 const g=grab(p,[0,0.42,0.60,0.78])
 let diff=0; if(prev){for(let k=0;k<g.L.length;k++)diff+=Math.abs(g.L[k]-prev[k]); diff/=g.L.length}
 prev=g.L
 console.log(`swash-${i} foamFrac ${(foam/n).toFixed(4)} stroke/W ${(per?2*foam/per/p.width:0).toFixed(4)} foamTopY ${(top<1e9?(top/p.height).toFixed(3):'-')} centroidY ${(foam?(sy/foam/p.height).toFixed(3):'-')} dL_prev ${diff.toFixed(4)}`)}
const sh=load(R+'shore-foam-wake.jpg')
{const b=bx(sh,[0.0,0.78,0.55,1.0]); let foam=0,n=0,per=0
 const isF=(x,y)=>{const o=(y*sh.width+x)*4;const[,s,v]=hsv(sh.data[o],sh.data[o+1],sh.data[o+2]);return s<0.15&&v>0.85}
 for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++){n++;if(!isF(x,y))continue;foam++
  for(const[dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy;if(xx<b.x0||yy<b.y0||xx>=b.x1||yy>=b.y1){per++;continue}if(!isF(xx,yy))per++}}
 console.log('REF shore swash band [0,.78,.55,1] foamFrac',(foam/n).toFixed(4),'stroke/W',(per?2*foam/per/sh.width:0).toFixed(4))}
{const b=bx(sh,[0.60,0.46,0.96,0.66]); let foam=0,n=0,per=0
 const isF=(x,y)=>{const o=(y*sh.width+x)*4;const[,s,v]=hsv(sh.data[o],sh.data[o+1],sh.data[o+2]);return s<0.15&&v>0.85}
 for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++){n++;if(!isF(x,y))continue;foam++
  for(const[dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy;if(xx<b.x0||yy<b.y0||xx>=b.x1||yy>=b.y1){per++;continue}if(!isF(xx,yy))per++}}
 console.log('REF ring chain foamFrac',(foam/n).toFixed(4),'stroke/W',(per?2*foam/per/sh.width:0).toFixed(4))}
