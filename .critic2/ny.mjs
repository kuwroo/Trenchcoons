import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
for(const spec of process.argv.slice(2)){
 const [id,v]=spec.split('#'); const a=reg.scatterAsset(id,+(v??0))
 for(const part of a.parts){
  const g=part.lods[0].geometry
  const pos=g.getAttribute('position'), idx=g.getIndex()
  const n=idx?idx.count:pos.count
  const P=k=>{const j=idx?idx.getX(k):k;return [pos.getX(j),pos.getY(j),pos.getZ(j)]}
  const cl=[]
  for(let t=0;t<n;t+=3){const A=P(t),B=P(t+1),C=P(t+2)
   const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],w=[C[0]-A[0],C[1]-A[1],C[2]-A[2]]
   const nv=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]
   const L=Math.hypot(...nv); if(L<1e-12)continue
   const nn=nv.map(x=>x/L)
   let h=cl.find(c=>c.n[0]*nn[0]+c.n[1]*nn[1]+c.n[2]*nn[2]>0.996)
   if(h)h.area+=L/2; else cl.push({n:nn,area:L/2})}
  const tot=cl.reduce((s,c)=>s+c.area,0)
  // area share by |ny| bucket: near-vertical WALL (|ny|<0.35), oblique, near-flat (|ny|>0.8)
  const wall=cl.filter(c=>Math.abs(c.n[1])<0.35).reduce((s,c)=>s+c.area,0)/tot
  const obl =cl.filter(c=>Math.abs(c.n[1])>=0.35&&Math.abs(c.n[1])<=0.8).reduce((s,c)=>s+c.area,0)/tot
  const flat=cl.filter(c=>Math.abs(c.n[1])>0.8).reduce((s,c)=>s+c.area,0)/tot
  cl.sort((a,b)=>b.area-a.area)
  console.log(`${spec} ${part.slot} L0: planes ${cl.length} | WALL(|ny|<.35) ${(wall*100).toFixed(0)}%  oblique ${(obl*100).toFixed(0)}%  flat(|ny|>.8) ${(flat*100).toFixed(0)}%  | largest plane ${(cl[0].area/tot*100).toFixed(0)}%  top3 ${(cl.slice(0,3).reduce((s,c)=>s+c.area,0)/tot*100).toFixed(0)}%`)
 }
}
await server.close()
