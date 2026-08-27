import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const hull = await server.ssrLoadModule('/src/assets/hull.ts')
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
for (const id of ['outcrop-shelf','cliff-block']) {
  const a = reg.scatterAsset(id, 0)
  const g = a.parts[0].lods[0]
  const pos = g.geometry.getAttribute('position')
  // cluster vertices into connected components by shared position
  const key=i=>`${Math.round(pos.getX(i)*1e3)},${Math.round(pos.getY(i)*1e3)},${Math.round(pos.getZ(i)*1e3)}`
  const idx=g.geometry.getIndex()
  const par=new Map()
  const find=k=>{while(par.get(k)!==k)k=par.get(k);return k}
  for(let i=0;i<pos.count;i++){const k=key(i);if(!par.has(k))par.set(k,k)}
  for(let t=0;t<idx.count;t+=3){
    const ks=[key(idx.getX(t)),key(idx.getX(t+1)),key(idx.getX(t+2))].map(find)
    for(const k of ks) par.set(k, ks[0])
  }
  const comps=new Map()
  for(const k of par.keys()){const r=find(k);comps.set(r,(comps.get(r)??0)+1)}
  console.log(`${id}: tris ${g.triangles} verts ${pos.count} components ${comps.size}`)
  // face area histogram
  const areas=[]
  for(let t=0;t<idx.count;t+=3){
    const P=j=>{const i=idx.getX(j);return [pos.getX(i),pos.getY(i),pos.getZ(i)]}
    const A=P(t),B=P(t+1),C=P(t+2)
    const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],w=[C[0]-A[0],C[1]-A[1],C[2]-A[2]]
    areas.push(0.5*Math.hypot(u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]))
  }
  areas.sort((x,y)=>x-y)
  console.log(`   area p10 ${areas[Math.floor(areas.length*0.1)].toFixed(3)} p50 ${areas[Math.floor(areas.length*0.5)].toFixed(3)} max ${areas[areas.length-1].toFixed(2)} total ${areas.reduce((a,b)=>a+b,0).toFixed(1)} m2`)
}
await server.close()
