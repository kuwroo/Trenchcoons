import { createServer } from 'vite'
const s = await createServer({ configFile:'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const reg = await s.ssrLoadModule('/src/assets/registry.ts')
console.log(['id','v','solid','shapes','kinds','proxy y0..y1','mesh y0..y1','h','foot'].join('\t'))
for (const id of reg.scatterIds()) for (let v=0;v<reg.scatterVariants(id);v++){
  const a=reg.scatterAsset(id,v); const c=a.collider
  let py0=1e9,py1=-1e9
  const kinds=[]
  for(const sh of c.shapes){ kinds.push(sh.kind ?? Object.keys(sh).join('/'))
    if(sh.points) for(const p of sh.points){py0=Math.min(py0,p[1]);py1=Math.max(py1,p[1])}
    if(sh.half!==undefined||sh.height!==undefined){const hy=sh.height??0; const cy=(sh.center?.[1])??0; py0=Math.min(py0,cy-hy/2);py1=Math.max(py1,cy+hy/2)} }
  let my0=1e9,my1=-1e9
  for(const part of a.parts){const p=part.lods[0].geometry.getAttribute('position');for(let k=0;k<p.count;k++){my0=Math.min(my0,p.getY(k));my1=Math.max(my1,p.getY(k))}}
  console.log([id,v,c.solid,c.shapes.length,[...new Set(kinds)].join(','),
    Number.isFinite(py0)?`${py0.toFixed(2)}..${py1.toFixed(2)}`:'-',
    `${my0.toFixed(2)}..${my1.toFixed(2)}`, a.bounds.height.toFixed(2), a.bounds.footprint.toFixed(2)].join('\t'))
}
console.log('\nSAMPLE SHAPE:', JSON.stringify(reg.scatterAsset('conifer-tall',0).collider.shapes[0]).slice(0,300))
await s.close()
