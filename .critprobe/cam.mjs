import { chromium } from 'playwright'
const b=await chromium.launch({headless:true,args:['--use-angle=metal','--enable-unsafe-swiftshader']})
const p=await b.newPage({viewport:{width:1600,height:900}})
const FLAT='time=0.62&warmup=64&spawn=720,-540&caryaw=0'
for(const f of [132,150,170,200,400]){
  await p.goto(`http://127.0.0.1:5173/?shot=1&${FLAT}&drive=&frame=${f}&camarm=0.7`,{waitUntil:'load'})
  await p.evaluate(()=>window.__ready)
  const c=await p.evaluate(()=>window.__trench.cam())
  console.log(f, JSON.stringify({x:+c.x.toFixed(4),y:+c.y.toFixed(4),z:+c.z.toFixed(4),fov:+c.fov.toFixed(3)}))
}
await b.close()
