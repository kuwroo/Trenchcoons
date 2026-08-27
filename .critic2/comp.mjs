import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
const pts = g => { const pos=g.getAttribute('position'); const a=[]; for(let i=0;i<pos.count;i++)a.push([pos.getX(i),pos.getY(i),pos.getZ(i)]); return a }
const tris = g => { const idx=g.getIndex(); const pos=g.getAttribute('position'); const n=idx?idx.count:pos.count; const o=[]
  for(let i=0;i<n;i+=3){ const j=k=>idx?idx.getX(i+k):i+k; o.push([j(0),j(1),j(2)]) } return o }
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
  for(const [r,vs] of grp){ const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9]
    for(const v of vs)for(let d=0;d<3;d++){mn[d]=Math.min(mn[d],w[v][d]);mx[d]=Math.max(mx[d],w[v][d])}
    out.push({mn,mx,verts:vs.length}) }
  return out.sort((a,b)=>a.mn[1]-b.mn[1])
}
for (const id of process.argv.slice(2)) {
  const [name,vs]=id.split('#')
  const a=reg.scatterAsset(name, +(vs??0))
  for(const part of a.parts){
    for(const [nm,l] of [...part.lods.map((l,i)=>['L'+i,l]),['imp',part.impostor]]){
      const c=comps(l.geometry)
      console.log(`${name}#${vs??0} ${part.slot} ${nm}: ${c.length} comps`)
      c.forEach((x,i)=>console.log(`   c${i} y[${x.mn[1].toFixed(3)},${x.mx[1].toFixed(3)}] x[${x.mn[0].toFixed(2)},${x.mx[0].toFixed(2)}] z[${x.mn[2].toFixed(2)},${x.mx[2].toFixed(2)}] v${x.verts}`))
      // vertical gap between consecutive comps whose xz footprints overlap
      for(let i=1;i<c.length;i++){ const a1=c[i-1],b1=c[i]
        const ox=Math.min(a1.mx[0],b1.mx[0])-Math.max(a1.mn[0],b1.mn[0])
        const oz=Math.min(a1.mx[2],b1.mx[2])-Math.max(a1.mn[2],b1.mn[2])
        const gap=b1.mn[1]-a1.mx[1]
        if(gap>0.001) console.log(`   !! GAP ${gap.toFixed(3)} m between c${i-1} and c${i} (xz overlap ${ox.toFixed(2)}x${oz.toFixed(2)})`)
      }
      // any comp not supported by ANY lower comp reaching it
      for(let i=1;i<c.length;i++){ const b1=c[i]
        let sup=false
        for(let j=0;j<c.length;j++){ if(j===i)continue; const a1=c[j]
          if(a1.mx[1] >= b1.mn[1]-1e-4 && a1.mn[1] < b1.mn[1] &&
             Math.min(a1.mx[0],b1.mx[0])>Math.max(a1.mn[0],b1.mn[0]) &&
             Math.min(a1.mx[2],b1.mx[2])>Math.max(a1.mn[2],b1.mn[2])) sup=true }
        if(!sup) console.log(`   !! UNSUPPORTED c${i} floor y=${b1.mn[1].toFixed(3)}`)
      }
    }
  }
}
await server.close()
