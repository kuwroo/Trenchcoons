import { createServer } from 'vite'
const server = await createServer({ configFile: 'vite.config.ts', server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
const b = await server.ssrLoadModule('/src/assets/budget.ts')
const r = b.scatterBudget()
console.log(`${r.defs} defs, ${r.assets} variants, ${r.batches} batches, worst ${r.worstCaseDraws} draws, ok=${r.ok}`)
for (const p of r.problems) console.log('  PROBLEM', p)
for (const row of r.rows) console.log(`${row.id}#${row.variant}`.padEnd(22), row.generator.padEnd(10), 'lods', row.lodTriangles.join('>'), ' floor', row.rungFloor.map(v=>v.toFixed(2)).join(','), ' imp', row.impostor, ' solid', row.solid, row.colliderShapes)
await server.close()
