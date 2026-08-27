import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import { WEBGPU_ARGS } from '/Users/chloeongsiyi/Trenchcoons/tools/shots.mjs'
const B='http://127.0.0.1:4173/forge.html?shot=1'
const SH=[
 ['crit-rock-close', `${B}&ids=rock-medium&row=1&time=0.62&dist=0.55&pitch=0.16`],
 ['crit-rock-close-noon', `${B}&ids=rock-medium&row=1&time=0.50&dist=0.55&pitch=0.16`],
 ['crit-boulder-close', `${B}&ids=boulder-large&row=1&time=0.62&dist=0.55&pitch=0.14`],
 ['crit-cliff-alone', `${B}&ids=cliff-block&row=1&time=0.62&dist=0.7&pitch=0.10`],
 ['crit-cliff-low', `${B}&ids=cliff-block&row=1&time=0.62&dist=0.85&pitch=0.02`],
 ['crit-outcrop-shelf', `${B}&ids=outcrop-shelf&row=1&time=0.62&dist=0.6&pitch=0.12`],
 ['crit-outcrop-step', `${B}&ids=outcrop-step&row=1&time=0.62&dist=0.6&pitch=0.12`],
 ['crit-conifer-close', `${B}&ids=conifer-tall&row=1&time=0.62&dist=0.6&pitch=0.10`],
 ['crit-conifer-noon', `${B}&ids=conifer-tall&row=1&time=0.50&dist=0.6&pitch=0.10`],
 ['crit-shrub-close', `${B}&ids=shrub-broadleaf&row=1&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-bush-close', `${B}&ids=bush-round&row=1&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-log-close', `${B}&ids=log-fallen&row=1&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-roots-close', `${B}&ids=roots-exposed&row=1&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-stump-close', `${B}&ids=stump-broken&row=1&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-grass-close', `${B}&ids=grass-tuft,grass-cluster&row=2&time=0.62&dist=0.5&pitch=0.14`],
 ['crit-rock-lod2', `${B}&ids=rock-medium&row=1&time=0.62&dist=0.55&pitch=0.16&lod=2`],
 ['crit-conifer-lod2', `${B}&ids=conifer-tall&row=1&time=0.62&dist=0.6&pitch=0.10&lod=2`],
 ['crit-conifer-imp', `${B}&ids=conifer-tall&row=1&time=0.62&dist=0.6&pitch=0.10&lod=imp`],
]
await fs.mkdir('.critic/shots',{recursive:true})
const br=await chromium.launch({args:WEBGPU_ARGS})
const pg=await br.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1})
for(const [n,u] of SH){
  await pg.goto(u,{waitUntil:'load'})
  await pg.evaluate(()=>window.__ready)
  await pg.waitForTimeout(400)
  await pg.screenshot({path:`.critic/shots/${n}.png`})
  console.log('ok',n)
}
await br.close()
