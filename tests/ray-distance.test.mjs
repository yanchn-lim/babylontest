import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { sceneRayDistance, transferRayDistance } from '../src/comparison/ray-distance.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('.wgsl?raw')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.wgsl?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(new URL(url.replace('?raw', '')), 'utf8')), shortCircuit: true };
  return next(url, context);
} });
const { transferSourceFor, transferShader, transferFingerprint } = await import('../src/comparison/transfer-data.ts');
const { activeTransferSource } = await import('../src/comparison/active-transfer.ts');

test('ray distance covers translated, rotated and scaled opaque geometry', () => {
  for (const scale of [.01, 1, 100]) for (const angle of [0, .7, 2.1]) {
    const points = [[-2,-1,-40],[2,1,40],[-2,1,40],[2,-1,-40]].map(([x,y,z]) =>
      [100 + scale * (x*Math.cos(angle)-z*Math.sin(angle)), 20+y*scale, -200+scale*(x*Math.sin(angle)+z*Math.cos(angle))]);
    const data = { materials: [{}, {transmitting:true}], meshes: [
      { material:0, positions:points.flat() }, { material:1, positions:[1e10,1e10,1e10] }] };
    const distance = sceneRayDistance(data);
    for (const a of points) for (const b of points) assert.ok(Math.fround(distance) > Math.hypot(...a.map((v,i)=>v-b[i]))+.004);
    assert.ok(distance < 1000*scale+1, 'Transparent geometry does not expand the traced bounds.');
    const moved = structuredClone(data); moved.meshes[0].positions = moved.meshes[0].positions.map(v=>v+50);
    assert.ok(Math.abs(sceneRayDistance(moved)-distance)<1e-8);
  }
});

test('legacy ray limit remains valid and unsupported distances fail explicitly', () => {
  assert.equal(transferRayDistance({}),24);
  for (const rayDistance of [0,-1,NaN,Infinity,1e50,1e-50]) assert.throws(()=>transferRayDistance({rayDistance}),/ray distance/);
  assert.throws(()=>sceneRayDistance({materials:[{}],meshes:[{material:0,positions:[NaN,0,0]}]}),/finite positions/);
  assert.throws(()=>sceneRayDistance({materials:[],meshes:[]}),/ray distance/);
});

test('new distances reach all preparation and final shaders without changing legacy source', async () => {
  const legacy = {fixtures:[{},{}]};
  assert.equal(transferSourceFor(legacy),transferShader);
  for (const count of [1,2,7]) for (const repair of [false,true]) {
    const data={fixtures:Array(count).fill({}),rayDistance:90,...(repair?{sampleRepair:{mesh:0}}:{})};
    for (const received of [false,true]) {
      const source=transferSourceFor(data,received);
      assert.ok(!source.includes('24.0'));
      assert.match(source,/params\.sun\.xyz,params\.origin\.w/);
      assert.match(source,/hemisphere\(surface\.normal\.xyz,ray,SKY_RAYS\),params\.origin\.w/);
    }
    if (!repair) assert.ok(!activeTransferSource(data,true).includes('24.0'));
  }
  assert.notDeepEqual(await transferFingerprint(legacy),await transferFingerprint({...legacy,rayDistance:24}));
  assert.notDeepEqual(await transferFingerprint({...legacy,rayDistance:24}),await transferFingerprint({...legacy,rayDistance:90}));
});
