import {PNG} from '/Users/chloeongsiyi/Trenchcoons/node_modules/pngjs/lib/png.js'; import fs from 'fs';
const load=p=>PNG.sync.read(fs.readFileSync(p));
const px=(im,x,y)=>{const i=(im.width*y+x)<<2;return [im.data[i],im.data[i+1],im.data[i+2]];};
const rgb2hsv=([r,g,b])=>{r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;
 if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}
 return [h, mx?d/mx:0, mx];};
const lum=([r,g,b])=>(0.2126*r+0.7152*g+0.0722*b)/255;
const hex=([r,g,b])=>'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
// patch stats over a box
function patch(im,x0,y0,w,h){let n=0,s=[0,0,0],ls=[],lmin=1,lmax=0;
 for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){const c=px(im,x,y);const l=lum(c);s[0]+=c[0];s[1]+=c[1];s[2]+=c[2];ls.push(l);if(l<lmin)lmin=l;if(l>lmax)lmax=l;n++;}
 const mean=s.map(v=>Math.round(v/n)); ls.sort((a,b)=>a-b);
 const mu=ls.reduce((a,b)=>a+b,0)/n; const sd=Math.sqrt(ls.reduce((a,b)=>a+(b-mu)**2,0)/n);
 return {hex:hex(mean),rgb:mean,hsv:rgb2hsv(mean).map(v=>+v.toFixed(3)),lum:+mu.toFixed(3),sd:+sd.toFixed(4),min:+lmin.toFixed(3),max:+lmax.toFixed(3)};}
globalThis.load=load; globalThis.patch=patch; globalThis.px=px; globalThis.hex=hex; globalThis.lum=lum; globalThis.rgb2hsv=rgb2hsv;
export {load,patch,px,hex,lum,rgb2hsv};
