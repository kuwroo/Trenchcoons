const TILE=8, RES=256
function hash2(ix,iy,salt){let h=ix*374761393+iy*668265263+salt*2147483647;h=(h^(h>>>13))*1274126177;return ((h^(h>>>16))>>>0)/4294967296}
const site=new Float32Array(TILE*TILE*2)
for(let gy=0;gy<TILE;gy++)for(let gx=0;gx<TILE;gx++){const i=gy*TILE+gx
  site[i*2]=gx+0.5+(hash2(gx,gy,1)-0.5)*0.98
  site[i*2+1]=gy+0.5+(hash2(gx,gy,2)-0.5)*0.98}
const px=RES/TILE
const oldv=[], newv=[]
for(let y=0;y<RES;y++)for(let x=0;x<RES;x++){
  const cx=(x+0.5)/px, cy=(y+0.5)/px
  const gx0=Math.floor(cx), gy0=Math.floor(cy)
  let f1=1e9,f2=1e9,bsx=0,bsy=0
  const nx=[],ny=[]
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const gx=gx0+dx, gy=gy0+dy
    const wx=((gx%TILE)+TILE)%TILE, wy=((gy%TILE)+TILE)%TILE
    const i=wy*TILE+wx
    const sx=site[i*2]+(gx-wx), sy=site[i*2+1]+(gy-wy)
    nx.push(sx); ny.push(sy)
    const d=Math.hypot(cx-sx,cy-sy)
    if(d<f1){f2=f1;f1=d;bsx=sx;bsy=sy} else if(d<f2){f2=d}
  }
  oldv.push(f2-f1)
  let hard=1e9
  for(let j=0;j<nx.length;j++){
    const dxs=nx[j]-bsx, dys=ny[j]-bsy
    const len=Math.hypot(dxs,dys); if(len<1e-6)continue
    const d=(((bsx+nx[j])*0.5-cx)*dxs+((bsy+ny[j])*0.5-cy)*dys)/len
    if(d<hard)hard=d
  }
  newv.push(hard*2)
}
const pct=(a,q)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(q*(b.length-1))]}
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length
for(const [n,a] of [['old F2-F1',oldv],['new 2*bisector',newv]])
  console.log(n.padEnd(16),'mean',mean(a).toFixed(4),' p10',pct(a,0.1).toFixed(4),' p50',pct(a,0.5).toFixed(4),' p90',pct(a,0.9).toFixed(4))
const rim=0.105
for(const [n,a] of [['old',oldv],['new',newv]])
  console.log(n.padEnd(16),'fraction below cellRim 0.105:',(100*a.filter(v=>v<rim).length/a.length).toFixed(1)+'%')
