import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
const ids = reg.scatterIds()
const pts = g => { const pos=g.getAttribute('position'); const a=[]; for(let i=0;i<pos.count;i++)a.push([pos.getX(i),pos.getY(i),pos.getZ(i)]); return a }
const tris = g => { const idx=g.getIndex(); const pos=g.getAttribute('position'); const n=idx?idx.count:pos.count; const o=[]
  for(let i=0;i<n;i+=3){ const j=k=>idx?idx.getX(i+k):i+k; o.push([j(0),j(1),j(2)]) } return o }
// connected components by welded vertex position
function comps(g){
  const P=pts(g), T=tris(g)
  const key=p=>p.map(v=>Math.round(v*1e4)).join(',')
  const wid=new Map(), w=[]
  const wof=P.map(p=>{const k=key(p); if(!wid.has(k)){wid.set(k,w.length); w.push(p)} return wid.get(k)})
  const par=w.map((_,i)=>i); const find=x=>{while(par[x]!==x){par[x]=par[par[x]];x=par[x]}return x}
  const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)par[a]=b}
  for(const t of T){ uni(wof[t[0]],wof[t[1]]); uni(wof[t[1]],wof[t[2]]) }
  const grp=new Map()
  for(let i=0;i<w.length;i++){const r=find(i); if(!grp.has(r))grp.set(r,[]); grp.get(r).push(i)}
  const out=[]
  for(const [r,vs] of grp){ let y0=1e9,y1=-1e9,n=vs.length
    for(const v of vs){ y0=Math.min(y0,w[v][1]); y1=Math.max(y1,w[v][1]) }
    out.push({n,y0,y1}) }
  // signed volume per component
  const rootOf=new Map(); out.forEach((c,i)=>{})
  const volByRoot=new Map()
  for(const t of T){ const r=find(wof[t[0]]); const a=P[t[0]],b=P[t[1]],c=P[t[2]]
    const v=(a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]))/6
    volByRoot.set(r,(volByRoot.get(r)??0)+v) }
  const roots=[...grp.keys()]
  return roots.map((r,i)=>{ const vs=grp.get(r); let y0=1e9,y1=-1e9
    for(const v of vs){y0=Math.min(y0,w[v][1]);y1=Math.max(y1,w[v][1])}
    return {verts:vs.length, y0:+y0.toFixed(3), y1:+y1.toFixed(3), vol:+(volByRoot.get(r)??0).toFixed(4)} })
}
function bbox(g){ const P=pts(g); const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9]
  for(const p of P)for(let d=0;d<3;d++){mn[d]=Math.min(mn[d],p[d]);mx[d]=Math.max(mx[d],p[d])}
  return {mn,mx} }
// facet histogram: group triangles by normal, area per normal cluster
function facets(g){ const P=pts(g),T=tris(g); const cl=[]
  for(const t of T){ const a=P[t[0]],b=P[t[1]],c=P[t[2]]
    const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],w2=[c[0]-a[0],c[1]-a[1],c[2]-a[2]]
    const n=[u[1]*w2[2]-u[2]*w2[1],u[2]*w2[0]-u[0]*w2[2],u[0]*w2[1]-u[1]*w2[0]]
    const L=Math.hypot(...n); if(L<1e-12)continue; const nn=n.map(v=>v/L); const ar=L/2
    let hit=null
    for(const c2 of cl){ if(c2.n[0]*nn[0]+c2.n[1]*nn[1]+c2.n[2]*nn[2] > 0.996){hit=c2;break} }
    if(hit){hit.area+=ar; hit.tris++} else cl.push({n:nn,area:ar,tris:1}) }
  cl.sort((a,b)=>b.area-a.area)
  const tot=cl.reduce((s,c)=>s+c.area,0)
  return {planes:cl.length, tot:+tot.toFixed(2), top:cl.slice(0,6).map(c=>+(c.area/tot).toFixed(3)),
    up:+(cl.filter(c=>c.n[1]>0.7).reduce((s,c)=>s+c.area,0)/tot).toFixed(3)}
}
const target = process.argv[2]
for (const id of ids){
  if (target && !id.includes(target)) continue
  for (let v=0; v<reg.scatterVariants(id); v++){
    const a = reg.scatterAsset(id, v)
    for (const part of a.parts){
      const rungs = [...part.lods.map((l,i)=>['L'+i,l]), ['imp', part.impostor]]
      for (const [nm,l] of rungs){
        const c = comps(l.geometry); const bb=bbox(l.geometry); const F=facets(l.geometry)
        const float = c.filter(x=>x.y0 > 0.02)
        const inv = c.filter(x=>x.vol < 0)
        console.log(`${id}#${v} ${part.slot} ${nm}`.padEnd(34),
          `bb y[${bb.mn[1].toFixed(2)},${bb.mx[1].toFixed(2)}] x${(bb.mx[0]-bb.mn[0]).toFixed(2)} z${(bb.mx[2]-bb.mn[2]).toFixed(2)}`,
          `comp ${c.length}`, float.length?`FLOATING ${float.map(f=>f.y0).join('/')}`:'', inv.length?`NEGVOL ${inv.length}`:'',
          `planes ${F.planes} biggest ${F.top.join('/')} up% ${F.up}`)
      }
    }
    console.log(`   -> bounds h=${a.bounds.height.toFixed(2)} foot=${a.bounds.footprint.toFixed(2)} solid=${a.collider?.solid} shapes=${a.collider?.shapes?.length ?? 0} impShared=${a.parts[0].impostorShared??'?'}`)
  }
}
await server.close()
