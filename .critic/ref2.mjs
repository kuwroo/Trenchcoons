import {load,patch} from '/Users/chloeongsiyi/Trenchcoons/.critic/probe.mjs';
const im=load('/Users/chloeongsiyi/Trenchcoons/.critic/ref.png');
console.log('size',im.width,im.height);
const s=(n,x,y,w,h)=>console.log(n.padEnd(30), JSON.stringify(patch(im,x,y,w,h)));
// big right-hand rock terrace
s('REF rock lit top (right)',   880, 400, 60, 25);
s('REF rock lit top 2',         960, 330, 50, 20);
s('REF rock vertical face',     880, 440, 60, 40);
s('REF rock vertical face 2',   700, 400, 40, 60);
s('REF rock dark crevice',      770, 470, 25, 30);
s('REF rock foreground slab',   560, 640, 40, 60);
s('REF conifer lit tier',       285, 400, 25, 25);
s('REF conifer shadow tier',    310, 440, 20, 20);
s('REF conifer right lit',     1120, 470, 30, 30);
s('REF conifer right shadow',  1090, 520, 25, 25);
s('REF grass lit',              400, 620, 80, 40);
s('REF grass shadow',           150, 560, 60, 30);
