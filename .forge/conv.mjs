import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
for (const [id,v] of [['rock-medium',0],['rock-slab',0],['boulder-large',0]]) {
  const a = reg.scatterAsset(id, v)
  a.parts[0].lods.forEach((l,li)=>{
    const pos=l.geometry.getAttribute('position'), idx=l.geometry.getIndex()
    const P=j=>{const i=idx.getX(j);return [pos.getX(i),pos.getY(i),pos.getZ(i)]}
    // centroid
    let c=[0,0,0]
    for(let i=0;i<pos.count;i++){c[0]+=pos.getX(i);c[1]+=pos.getY(i);c[2]+=pos.getZ(i)}
    c=c.map(x=>x/pos.count)
    let bad=0, out=0
    for(let t=0;t<idx.count;t+=3){
      const A=P(t),B=P(t+1),C=P(t+2)
      const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],w=[C[0]-A[0],C[1]-A[1],C[2]-A[2]]
      const n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]
      const len=Math.hypot(...n); if(len<1e-12) continue
      const nn=n.map(x=>x/len)
      const d=nn[0]*(A[0]-c[0])+nn[1]*(A[1]-c[1])+nn[2]*(A[2]-c[2])
      if(d<0) bad++   // face normal points toward the centroid: inverted
      // convexity: every vertex must be on the inner side of this plane
      let viol=0
      for(let i=0;i<pos.count;i++){
        const q=[pos.getX(i),pos.getY(i),pos.getZ(i)]
        const s=nn[0]*(q[0]-A[0])+nn[1]*(q[1]-A[1])+nn[2]*(q[2]-A[2])
        if(s>1e-3) viol++
      }
      if(viol) out++
    }
    console.log(`${id} lod${li}: tris ${idx.count/3} inverted ${bad} nonconvexFaces ${out}`)
  })
}
await server.close()
