import { createServer } from 'vite'
const s = await createServer({ configFile:'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const h = await s.ssrLoadModule('/src/assets/hull.ts')
const D = h.HULL_DIRECTIONS
console.log('total directions', D.length)
for (const dirs of [8,10,14]) {
  const step = Math.max(1, Math.floor(D.length/dirs))
  const kept = D.filter((_,i)=> i%step===0)
  const minY = Math.min(...kept.map(d=>d[1]))
  console.log(`dirs=${dirs} step=${step} kept=${kept.length}  most-downward Y component = ${minY.toFixed(3)}  (need ~-1 to clip a floor)`)
  console.log('   kept Y comps:', kept.map(d=>d[1].toFixed(2)).join(' '))
}
await s.close()
