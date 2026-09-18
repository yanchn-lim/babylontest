import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({resolve(s,c,n) {
  if ((c.parentURL?.includes('/src/')||c.parentURL?.includes('/fixtures/')) && s.startsWith('.') && !/\.[a-z]+$/.test(s)) return n(s+'.ts',c);
  return n(s,c);
}});
const { architecturalCharts }=await import('../src/apartment/lighting-charts.ts');
const { architecturalCharts: reference }=await import('./fixtures/lighting-charts-reference.ts');
const quad=(points,normal,transmitting=false)=>({positions:[0,1,2,0,2,3].flatMap(i=>points[i]),normals:Array(6).fill(normal).flat(),transmitting});

test('spatial chart queries match all-pairs output across layouts, scales and orientations', () => {
  for(const size of [2,6])for(const scale of [.1,1,30])for(const angle of [0,.71]) {
    const geometry=[];
    for(let x=0;x<size;x++)for(let z=0;z<size;z++) {
      geometry.push(quad([[x,0,z],[x+1,0,z],[x+1,0,z+1],[x,0,z+1]],[0,1,0]));
      if(x%2===0)geometry.push(quad([[x,0,z],[x,2,z],[x,2,z+1],[x,0,z+1]],[1,0,0],z%3===0));
    }
    geometry.push(quad([[size,0,0],[size+1,0,0],[size+1,0,.5],[size,0,.5]],[0,1,0]));
    geometry.push(quad([[20,0,0],[21,0,0],[21,0,1],[20,0,1]],[0,1,0]));
    geometry.push(quad([[1,0,0],[1,2,0],[1,2,size],[1,0,size]],[1,0,0]));
    for(const mesh of geometry)for(const key of ['positions','normals'])for(let i=0;i<mesh[key].length;i+=3) {
      const [x,y,z]=mesh[key].slice(i,i+3),s=key==='positions'?scale:1,t=key==='positions'?71:0;
      mesh[key].splice(i,3,s*(x*Math.cos(angle)-z*Math.sin(angle))+t,s*y+t,s*(x*Math.sin(angle)+z*Math.cos(angle))-t);
    }
    const furniture=new Set([geometry.length-1]);
    assert.deepEqual(architecturalCharts(geometry,furniture),reference(geometry,furniture));
  }
});

test('spatial queries preserve near-touching edge and blocker tolerances', () => {
  for(const gap of [-1.1e-5,-.9e-5,0,.9e-5,1.1e-5]) {
    const geometry=[quad([[-1,0,0],[0,0,0],[0,0,1],[-1,0,1]],[0,1,0]),
      quad([[gap,0,0],[1,0,0],[1,0,2],[gap,0,2]],[0,1,0])];
    for(const offset of [0,.008-1.1e-5,.008-.9e-5,.008+.9e-5,.008+1.1e-5]) {
      const blocker=quad([[0,offset,0],[0,1,0],[0,1,2],[0,offset,2]],[-1,0,0]);
      const input=[...geometry,blocker];
      assert.deepEqual(architecturalCharts(input,new Set()),reference(input,new Set()));
    }
  }
});
