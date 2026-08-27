import { createServer } from 'vite'
const s=await createServer({configFile:'vite.config.ts',server:{middlewareMode:true},appType:'custom',logLevel:'error'})
const r=await s.ssrLoadModule('/src/assets/registry.ts')
for(const id of ['rock-medium','boulder-large','cliff-block','outcrop-shelf','conifer-tall','shrub-broadleaf']){
  const a=r.scatterAsset(id,0)
  for(const p of a.parts) console.log(id.padEnd(17), p.slot.padEnd(8),
    'switch@', p.lods.map(l=>l.until===Infinity?'inf':l.until.toFixed(0)+'m').join(' / '),
    ' tris', p.lods.map(l=>l.triangles).join('/'), ' imp', p.impostor.triangles, p.impostorShared?'(shared)':'')
}
await s.close()
