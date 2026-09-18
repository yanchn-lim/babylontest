import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({resolve(s,c,n) {
  if (c.parentURL?.includes('/src/') && s.startsWith('.') && !/\.[a-z]+$/.test(s)) return n(s+'.ts',c);
  return n(s,c);
}});
const { TransferHitPacker } = await import('../src/comparison/transfer-packing.ts');
const { packTransferEntry } = await import('../src/comparison/transfer-layout.ts');

test('reused typed counters match Map bytes, order and counts over changing rows', () => {
  for (const bits of [16,21]) {
    const pixels = bits === 16 ? 65536 : 2097152;
    const packer = new TransferHitPacker(pixels,bits), output = new Uint32Array(2048);
    let random = 7919;
    for (let row=0;row<100;row++) {
      const hits=Uint32Array.from({length:1024},(_,i)=> {
        random = (Math.imul(random,1664525)+1013904223)>>>0;
        if(row===0) return pixels-1;
        if(row===1) return 0xffffffff;
        if(row===2) return i;
        return random%8===0 ? 0xfffffffe : random%7===0 ? 0xffffffff : (random%200)*31;
      });
      const weights=new Map(); let backfaces=0,represented=0;
      for(const target of hits) {
        if(target===0xfffffffe) {backfaces++;continue;}
        if(target===0xffffffff) continue;
        weights.set(target,(weights.get(target)||0)+1);represented++;
      }
      output.fill(0xabcdef01);
      const count=packer.pack(hits,0,output,17);
      assert.deepEqual([...output.subarray(17,17+count)],[...weights].map(([target,weight])=>packTransferEntry(target,weight,bits)));
      assert.equal(packer.backfaces,backfaces); assert.equal(packer.representedHits,represented);
      assert.equal(output[16],0xabcdef01); assert.equal(output[17+count],0xabcdef01);
    }
  }
});
