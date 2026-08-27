import { chromium } from 'playwright'
import { WEBGPU_ARGS } from '/Users/chloeongsiyi/Trenchcoons/tools/shots.mjs'
const B='http://127.0.0.1:4173/forge.html?shot=1'
const SH=[
 ['crit-cliff-lod1', `${B}&ids=cliff-block&row=1&time=0.62&dist=0.85&pitch=0.02&lod=1`],
 ['crit-cliff-lod2', `${B}&ids=cliff-block&row=1&time=0.62&dist=0.85&pitch=0.02&lod=2`],
 ['crit-shelf-lod0', `${B}&ids=outcrop-shelf&row=1&time=0.62&dist=0.8&pitch=0.04&lod=0`],
 ['crit-shelf-lod1', `${B}&ids=outcrop-shelf&row=1&time=0.62&dist=0.8&pitch=0.04&lod=1`],
]
const br=await chromium.launch({args:WEBGPU_ARGS})
const pg=await br.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1})
for(const [n,u] of SH){ await pg.goto(u,{waitUntil:'load'}); await pg.evaluate(()=>window.__ready); await pg.waitForTimeout(300); await pg.screenshot({path:`.critic/shots/${n}.png`}); console.log('ok',n) }
await br.close()
