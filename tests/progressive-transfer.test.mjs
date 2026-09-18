import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test, mock } from 'node:test';
registerHooks({resolve(s,c,n) {
  if (c.parentURL?.includes('/src/') && s.startsWith('.') && !/\.[a-z]+$/.test(s)) return n(s+'.ts',c);
  return n(s,c);
}});
const { progressiveRay, ProgressiveHitPacker, ProgressiveRows } = await import('../src/comparison/progressive-transfer.ts');
const { TransferHitPacker } = await import('../src/comparison/transfer-packing.ts');

test('progressive passes visit every original ray once with spread-out early coverage', () => {
  const rays = Array.from({length:1024}, (_,i) => progressiveRay(i));
  assert.deepEqual([...rays].sort((a,b)=>a-b), Array.from({length:1024},(_,i)=>i));
  for (const count of [64,128,256,512]) assert.equal(new Set(rays.slice(0,count).map(ray=>Math.floor(ray/(1024/count)))).size,count);
});

test('partial hit counts restore exact reference weights and first-hit order', () => {
  for (const bits of [16,21]) {
    const n=2**bits, original=new TransferHitPacker(n,bits), progressive=new ProgressiveHitPacker(n,bits);
    let seed=7919;
    for (let row=0;row<40;row++) {
      const hits=Uint32Array.from({length:1024},(_,i)=>{
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        if(row===0)return n-1;
        if(row===1)return 0xffffffff;
        if(row===2)return i;
        return seed%9===0?0xfffffffe:seed%7===0?0xffffffff:(seed%250)*31;
      });
      const expected=new Uint32Array(1024), length=original.pack(hits,0,expected,0);
      let previous, start=0;
      for(const end of [64,128,256,512,1024]) {
        const partial=Uint32Array.from({length:end-start},(_,i)=>hits[progressiveRay(start+i)]);
        const entries=new Uint32Array(1024), firstRays=new Uint16Array(1024);
        const count=progressive.pack(partial,0,start,end,entries,firstRays,0,previous);
        previous={entries:entries.slice(0,count),firstRays:firstRays.slice(0,count)};start=end;
      }
      assert.deepEqual(previous.entries,expected.slice(0,length));
      assert.equal(progressive.representedHits,original.representedHits);
    }
  }
});

test('partial rows survive batch boundary changes, including empty rows', () => {
  const rows=new ProgressiveRows();
  rows.add(0,new Uint32Array([0,1,1]),new Uint32Array([7]),new Uint16Array([12]));
  rows.add(2,new Uint32Array([0,2,3]),new Uint32Array([8,9,10]),new Uint16Array([13,14,15]));
  assert.deepEqual([...rows.take(0).entries],[7]);
  assert.deepEqual([...rows.take(1).entries],[]);
  assert.deepEqual([...rows.take(2).firstRays],[13,14]);
  assert.deepEqual([...rows.take(3).entries],[10]);
  assert.equal(rows.take(4),undefined);
});


test('checkpoint snapshot expands occupied rows without consuming the next pass input', () => {
  const rows=new ProgressiveRows();
  rows.add(0,new Uint32Array([0,1,1]),new Uint32Array([7]),new Uint16Array([12]));
  rows.add(2,new Uint32Array([0,2]),new Uint32Array([8,9]),new Uint16Array([13,14]));
  const snapshot=rows.snapshot(new Uint32Array([1,3,5]),8);
  assert.deepEqual([...snapshot.offsets],[0,0,1,1,1,1,3,3,3]);
  assert.deepEqual([...snapshot.entries],[7,8,9]);
  snapshot.entries[0]=99;
  assert.deepEqual([...rows.take(0).entries],[7]);
  assert.deepEqual([...rows.take(1).entries],[]);
  assert.deepEqual([...rows.take(2).entries],[8,9]);
  assert.throws(()=>rows.snapshot(new Uint32Array([1,3,5]),8),/consumed/);
});

test('transient checkpoints reject invalid rays, offsets, energy and visibility', async () => {
  const {validateCheckpoint}=await import('../src/comparison/transfer-checkpoint.ts');
  const data={fixtures:[]};
  const checkpoint=()=>({rays:64,offsets:Uint32Array.from({length:65537},(_,i)=>i?1:0),
    entries:new Uint32Array([(64<<16)|3]),visibility:new Float32Array(65536*4)});
  const check=value=>validateCheckpoint(value,data,async()=>{});
  assert.equal((await check(checkpoint())).frontHits,undefined);
  for(const rays of [64,128,256,512]) {
    const value=checkpoint();value.rays=rays;value.entries[0]=(rays<<16)|3;
    const result=await validateCheckpoint(value,data,async()=>{},true);
    assert.equal(result.frontHits[0],rays);
  }
  const counted=await validateCheckpoint(checkpoint(),data,async()=>{},true);
  assert.equal(counted.frontHits[0],64);
  assert.ok(counted.frontHits.subarray(1).every(v=>v===0));
  let value=checkpoint();value.rays=1024;await assert.rejects(check(value),/Invalid/);
  value=checkpoint();value.offsets[1]=2;await assert.rejects(check(value),/offsets/);
  value=checkpoint();value.entries[0]=(65<<16)|3;await assert.rejects(check(value),/ray count/);
  value=checkpoint();value.entries[0]=3;await assert.rejects(check(value),/connection/);
  value=checkpoint();value.visibility[0]=NaN;await assert.rejects(check(value),/visibility/);
  value=checkpoint();value.visibility[3]=256;await assert.rejects(check(value),/visibility/);
});


test('CPU work budget yields only after elapsed work and resets after the pause', async () => {
  const {workBudget}=await import('../src/comparison/work-budget.ts');
  let now=0,yields=0;
  const clock=mock.method(performance,'now',()=>now);
  try {
    const pause=workBudget(async()=>{yields++;now+=20;});
    for(let i=0;i<1000;i++)assert.equal(pause(),undefined);
    now=3.9;assert.equal(pause(),undefined);
    now=4;await pause();assert.equal(yields,1);
    now=27;assert.equal(pause(),undefined);
    now=28;await pause();assert.equal(yields,2);
    const synchronous=workBudget();now+=100;assert.equal(synchronous(),undefined);
  }finally{clock.mock.restore();}
});
