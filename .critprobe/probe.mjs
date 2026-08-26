import { chromium } from 'playwright'
const ARGS=['--use-angle=metal','--enable-unsafe-swiftshader']
const BASE='http://127.0.0.1:5173'
const FLAT='time=0.62&warmup=64&spawn=720,-540&caryaw=0'
const jobs=[
 ['idle132',`${FLAT}&drive=&frame=132&camarm=0.7`],
 ['idle150',`${FLAT}&drive=&frame=150&camarm=0.7`],
 ['idle170',`${FLAT}&drive=&frame=170&camarm=0.7`],
 ['idle200',`${FLAT}&drive=&frame=200&camarm=0.7`],
 ['idle132b',`${FLAT}&drive=&frame=132&camarm=0.7`],
 // side view of parked car to judge wheel contact + shadow
 ['idleside',`${FLAT}&drive=&frame=132&camarm=1.1&camyaw=1.55`],
 ['launchwide',`${FLAT}&drive=throttle:0-400&frame=28&camyaw=-0.5&camarm=1.4`],
]
const b=await chromium.launch({headless:true,args:ARGS})
const p=await b.newPage({viewport:{width:1600,height:900}})
const errs=[]
p.on('pageerror',e=>errs.push(String(e)))
p.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
for(const [n,q] of jobs){
  await p.goto(`${BASE}/?shot=1&${q}`,{waitUntil:'load',timeout:60000})
  await p.evaluate(()=>window.__ready)
  const tel=await p.evaluate(()=>window.__trench.car())
  await p.screenshot({path:`/tmp/crit/p-${n}.png`})
  console.log(n, JSON.stringify(tel && {sp:+tel.speed.toFixed(2),pitch:+(tel.pitch*57.3).toFixed(2),roll:+(tel.roll*57.3).toFixed(2),squash:+tel.squash.toFixed(4),idle:+tel.idle.toFixed(3),contacts:tel.contacts,y:+tel.y.toFixed(3),w:tel.wheels.map(w=>+w.compression.toFixed(3))}))
}
if(errs.length) console.log('ERRORS:',[...new Set(errs)].slice(0,8))
await b.close()
