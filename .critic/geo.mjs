import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await server.ssrLoadModule('/src/assets/registry.ts')
const ids = reg.scatterIds()
const rows=[]
for (const id of ids) {
  const nv = reg.scatterVariants(id)
  for (let v=0; v<nv; v++){
    const a = reg.scatterAsset(id, v)
    for (const part of a.parts){
      part.lods.forEach((l,i)=>{
        const g=l.geometry
        const pos=g.getAttribute('position')
        const idx=g.getIndex()
        const n=idx?idx.count/3:pos.count/3
        // degenerate + open-edge analysis
        let degen=0, minArea=Infinity, maxArea=0
        const edge=new Map()
        const key=(x,y,z)=>`${Math.round(x*1e4)},${Math.round(y*1e4)},${Math.round(z*1e4)}`
        const P=k=>{const j=idx?idx.getX(k):k;return [pos.getX(j),pos.getY(j),pos.getZ(j)]}
        for(let t=0;t<n;t++){
          const a0=P(t*3),b0=P(t*3+1),c0=P(t*3+2)
          const u=[b0[0]-a0[0],b0[1]-a0[1],b0[2]-a0[2]], w=[c0[0]-a0[0],c0[1]-a0[1],c0[2]-a0[2]]
          const cx=u[1]*w[2]-u[2]*w[1], cy=u[2]*w[0]-u[0]*w[2], cz=u[0]*w[1]-u[1]*w[0]
          const ar=0.5*Math.hypot(cx,cy,cz)
          if(ar<1e-9)degen++; minArea=Math.min(minArea,ar); maxArea=Math.max(maxArea,ar)
          const ks=[key(...a0),key(...b0),key(...c0)]
          for(let e=0;e<3;e++){const A=ks[e],B=ks[(e+1)%3];const k2=A<B?A+'|'+B:B+'|'+A;edge.set(k2,(edge.get(k2)??0)+1)}
        }
        let open=0,nonman=0
        for(const c of edge.values()){ if(c===1)open++; else if(c>2)nonman++ }
        // bbox
        let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9]
        for(let k=0;k<pos.count;k++){for(let d=0;d<3;d++){const val=pos.getX.bind(pos);}
          mn[0]=Math.min(mn[0],pos.getX(k));mn[1]=Math.min(mn[1],pos.getY(k));mn[2]=Math.min(mn[2],pos.getZ(k))
          mx[0]=Math.max(mx[0],pos.getX(k));mx[1]=Math.max(mx[1],pos.getY(k));mx[2]=Math.max(mx[2],pos.getZ(k))}
        rows.push({id,v,slot:part.slot,lod:i,tris:n,degen,open,nonman,
          minAr:+minArea.toFixed(6),y0:+mn[1].toFixed(3),y1:+mx[1].toFixed(3)})
      })
    }
    rows.push({id,v,slot:'*',lod:'BOUNDS',tris:'',degen:'',open:'',nonman:'',minAr:'',
      y0:'h='+a.bounds.height.toFixed(2),y1:'foot='+a.bounds.footprint.toFixed(2)})
  }
}
console.log(['id','v','slot','lod','tris','degen','openEdge','nonMan','minArea','y0','y1'].join('\t'))
for(const r of rows) console.log([r.id,r.v,r.slot,r.lod,r.tris,r.degen,r.open,r.nonman,r.minAr,r.y0,r.y1].join('\t'))
await server.close()
