import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const geometry = JSON.parse(readFileSync(new URL('../docs/lighting-verification/probe-production-step5/apartment-angular-gap-context.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/interior-lighting/probe-trace.wgsl', import.meta.url), 'utf8');
const offset = Number(source.match(/let p=position\+d\*h.distance\+n\*([.\d]+);/)?.[1]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function clearance(origin,direction){
  let nearest=Infinity;
  for(const t of geometry.triangles){
    if(geometry.transmitting[t.material])continue;
    const e=sub(t.b,t.a),f=sub(t.c,t.a),h=cross(direction,f),det=dot(e,h);
    if(Math.abs(det)<1e-8)continue;
    const s=sub(origin,t.a),u=dot(s,h)/det,q=cross(s,e),v=dot(direction,q)/det,d=dot(f,q)/det;
    if(u>=0&&v>=0&&u+v<=1&&d>1e-5)nearest=Math.min(nearest,d);
  }
  return nearest;
}
test('secondary GI origins stay inside the recorded apartment clearances',()=>{
  assert.ok(Number.isFinite(offset)&&offset>0,'Read the active bounce-origin expression');
  for(const [position,normal] of [
    [[-5.770262559254964,2.0899999141693115,-1.9369575182596843],[0,1,0]],
    [[-4.239999771118164,.9833333293596903,-1.0166666905085247],[-1,0,0]],
  ]){
    const distance=clearance(position,normal);
    assert.ok(distance<.015,'The former 15 mm origin crosses opaque geometry');
    assert.ok(offset<distance,`Bounce offset ${offset} crosses clearance ${distance}`);
  }
});
