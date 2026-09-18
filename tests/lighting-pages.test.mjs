import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
registerHooks({ resolve(s,c,n) {
  if (s.endsWith('.wgsl?raw')) return { url: new URL(s,c.parentURL).href, shortCircuit:true };
  if (c.parentURL?.includes('/src/') && s.startsWith('.') && !/\.[a-z]+$/.test(s)) return n(s+'.ts',c);
  return n(s,c);
}, load(url,c,n) {
  if (url.endsWith('.wgsl?raw')) return { format:'module', source:'export default '+JSON.stringify(readFileSync(new URL(url.replace('?raw','')),'utf8')), shortCircuit:true };
  return n(url,c);
} });
const { generateLightingPages } = await import('../src/apartment/lighting-pages.ts');
const { LightingAtlasCache } = await import('../src/apartment/lighting-atlas-cache.ts');
const { generateLightingAtlas } = await import('../src/apartment/lighting-atlas.ts');
const { transferLayout, packTransferEntry } = await import('../src/comparison/transfer-layout.ts');
const { decodeTransfer, transferFingerprint } = await import('../src/comparison/transfer-data.ts');
const { geometry: surfaceGeometry } = await import('../src/comparison/surface-geometry.ts');
const quad = { positions:[0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0], normals:Array(6).fill([0,0,1]).flat(), transmitting:false };

test('apartment coordinates and existing furniture slots survive add, reorder and remove', async () => {
  const first = await generateLightingPages([quad,quad],new Map([['chair',[1]]]),{});
  const second = await generateLightingPages([quad,quad,quad],new Map([['table',[2]],['chair',[1]]]),{previousLayout:first.layout});
  assert.deepEqual(first.atlas[0],second.atlas[0]);
  assert.deepEqual(first.atlas[1],second.atlas[1]);
  assert.deepEqual(first.layout.allocations[0],second.layout.allocations.find(v=>v.id==='chair'));
  const third = await generateLightingPages([quad,quad,quad],new Map([['chair',[1]],['table',[2]]]),{previousLayout:second.layout});
  assert.deepEqual(third.atlas,second.atlas);
  const removed = await generateLightingPages([quad,quad],new Map([['chair',[1]]]),{previousLayout:third.layout});
  assert.deepEqual(removed.atlas,first.atlas);
  assert.ok(second.atlas[1].filter((_,i)=>i%2).every(v=>v>1));
  assert.equal(second.stats.furnitureAllocations,2);
});

test('invalid ownership and prior layout bounds fail; degenerate furniture needs no slot', async () => {
  await assert.rejects(generateLightingPages([quad],new Map([['a',[0]],['b',[0]]]),{}),/repeated/);
  await assert.rejects(generateLightingPages([quad],new Map(),{previousLayout:{version:1,width:256,height:320,allocations:[{id:'a',x:0,y:256,size:128}]}}),/Invalid previous/);
  const empty = {...quad,positions:Array(18).fill(0)};
  await assert.rejects(generateLightingPages([quad,{...empty,positions:Array(18).fill(NaN)}],new Map([['bad',[1]]]),{}),/Invalid lighting geometry/);
  const result = await generateLightingPages([quad,empty],new Map([['empty',[1]]]),{});
  assert.equal(result.stats.ignoredTriangles,2);
  assert.equal(result.layout.allocations.length,0);
  assert.ok(result.atlas[1].every(v=>v===0));
});

test('sub-millimetre IKEA chair and cabinet faces keep valid lighting charts', async () => {
  const positions = [
    [6.579464681944071,.6470609591644099,-4.053947700545844,6.579366006329476,.6483794116775279,-4.053302324137174,6.579366006329476,.6472074538880896,-4.053947700545844],
    [5.98332578658766,.09169086918607539,-1.248658703147946,5.98332578658766,.09157465830546752,-1.248716708359911,5.98405212959198,.0908192838575248,-1.2491225961885881],
  ];
  for (const points of positions) {
    const mesh={positions:points,normals:[1,0,0,1,0,0,1,0,0],transmitting:false};
    const result=await generateLightingPages([mesh],new Map([['tiny',[0]]]),{});
    assert.equal(result.stats.ignoredTriangles,0);
    assert.equal(result.stats.charts,1);
    assert.ok(result.atlas[0].some(v=>v>1));
    assert.deepEqual(mesh.positions,points);
  }
});

test('three detailed sofas fit separate allocations with unchanged apartment UVs', async () => {
  const apartment=JSON.parse(readFileSync(new URL('../public/apartment-transfer/scene.json',import.meta.url)));
  const sofa=JSON.parse(readFileSync(new URL('../public/comparison/applaryd/scene.json',import.meta.url)));
  const expand=(m,d)=>({positions:m.indices.flatMap(i=>m.positions.slice(i*3,i*3+3)),normals:m.indices.flatMap(i=>m.normals.slice(i*3,i*3+3)),transmitting:!!d.materials[m.material].transmitting});
  const meshes=apartment.meshes.map(m=>expand(m,apartment)),groups=new Map();
  const original=await generateLightingPages(meshes,groups,{});
  for(let copy=0;copy<3;copy++) {
    const indices=[];
    for(const mesh of sofa.meshes.slice(2)) { indices.push(meshes.length); meshes.push(expand(mesh,sofa)); }
    groups.set('sofa-'+copy,indices);
  }
  const result=await generateLightingPages(meshes,groups,{});
  assert.deepEqual(result.atlas.slice(0,apartment.meshes.length),original.atlas);
  assert.equal(result.stats.furnitureAllocations,3); assert.equal(result.stats.ignoredTriangles,15);
  assert.ok(result.layout.height>256);
  assert.equal(result.stats.atlasBuilds,2); assert.equal(result.stats.atlasCacheHits,2);
});

test('cached atlases are isolated and invalidate on geometry, normals and size changes', async () => {
  const cache=new LightingAtlasCache();
  const first=await cache.generate([quad],true,64);
  const expected=structuredClone(first.atlas); first.atlas[0].fill(0);
  const second=await cache.generate([quad],true,64);
  assert.equal(second.reused,true); assert.deepEqual(second.atlas,expected);
  assert.equal((await cache.generate([{...quad,positions:quad.positions.map(v=>v*2)}],true,64)).reused,false);
  assert.equal((await cache.generate([{...quad,normals:quad.normals.map(v=>-v)}],true,64)).reused,false);
  assert.equal((await cache.generate([quad],true,128)).reused,false);
  cache.clear(); assert.equal((await cache.generate([quad],true,64)).reused,false);
  const abort=new AbortController();abort.abort();
  await assert.rejects(cache.generate([quad],true,64,abort.signal),{name:'AbortError'});
});

test('repeat builds reuse architecture and furniture; changing architecture rebuilds only its atlas', async () => {
  const atlasCache=new LightingAtlasCache(), groups=new Map([['chair',[1]]]);
  const first=await generateLightingPages([quad,quad],groups,{atlasCache});
  const warm=await generateLightingPages([quad,quad],groups,{atlasCache,previousLayout:first.layout});
  assert.deepEqual(warm.atlas,first.atlas);assert.equal(warm.stats.atlasBuilds,0);assert.equal(warm.stats.atlasCacheHits,2);
  const changed={...quad,positions:quad.positions.map(v=>v*2)};
  const edited=await generateLightingPages([changed,quad],groups,{atlasCache,previousLayout:first.layout});
  assert.equal(edited.stats.atlasBuilds,1);assert.equal(edited.stats.atlasCacheHits,1);
});

test('allocation retries reuse charts and match independent successful-size packing', async () => {
  const boxes=Array.from({length:200},(_,i)=>({...quad,positions:quad.positions.map((v,j)=>v+(j%3===0?i*2:0))}));
  const furniture=new Set(boxes.map((_,i)=>i));
  await assert.rejects(generateLightingAtlas(boxes,furniture,{size:64}),/capacity/);
  const retried=await generateLightingAtlas(boxes,furniture,{size:64,maxSize:256});
  assert.ok(retried.stats.size>64);
  const direct=await generateLightingAtlas(boxes,furniture,{size:retried.stats.size});
  assert.deepEqual(retried.atlas,direct.atlas);
  assert.ok(retried.stats.packingAttempts>direct.stats.packingAttempts);
});

test('21-bit cache addresses preserve high targets and 1024-ray weights', async () => {
  const data={meshes:[],materials:[],fixtures:[],sky:[1,1,1],views:{},lightingLayout:{version:1,width:256,height:320,allocations:[]}};
  const layout=transferLayout(data), n=layout.pixels;
  const bytes=new Uint8Array(64+(n+1)*4+n*16+4);
  new Uint32Array(bytes.buffer,0,8).set([0x31544644,2,256,1024,1,320,21]);
  bytes.set(await transferFingerprint(data),32);
  const offsets=new Uint32Array(bytes.buffer,64,n+1); offsets.fill(1,1);
  const entries=new Uint32Array(bytes.buffer,bytes.byteLength-4,1);
  entries[0]=packTransferEntry(70000,1024,21);
  const decoded=await decodeTransfer(bytes.buffer,data);
  assert.equal(decoded.entries[0]&layout.mask,70000); assert.equal(decoded.entries[0]>>>21,1024);
  assert.equal(packTransferEntry(2097151,1024,21)&layout.mask,2097151);
  entries[0]=packTransferEntry(n,1,21);
  await assert.rejects(decodeTransfer(bytes.buffer,data),/target/);
  assert.throws(()=>transferLayout({lightingLayout:{...data.lightingLayout,height:8193}}),/dimensions/);
});

test('surface rasterization retains furniture samples above row 255', () => {
  const uvs=[.1,1.1,.12,1.1,.12,1.12,.1,1.1,.12,1.12,.1,1.12];
  const data={materials:[{color:[1,1,1]}],meshes:[{...quad,uvs,indices:[0,1,2,3,4,5],material:0}],lightingLayout:{version:1,width:256,height:320,allocations:[]}};
  const result=surfaceGeometry(data);
  assert.equal(result.surfaces.length,256*320*12);
  assert.equal(result.surfaces.subarray(0,65536*12).some(v=>v!==0),false);
  assert.ok(result.surfaces.subarray(65536*12).some(v=>v!==0));
});

test('existing apartment and repaired APPLARYD caches still validate without regeneration', async () => {
  for (const folder of ['apartment-transfer','comparison/applaryd']) {
    const data=JSON.parse(readFileSync(new URL(`../public/${folder}/scene.json`,import.meta.url)));
    const raw=gunzipSync(readFileSync(new URL(`../public/${folder}/${folder.includes('applaryd')?'corrected/':''}transfer.bin.gz`,import.meta.url)));
    const result=await decodeTransfer(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),data);
    assert.ok(result.entries.length>0); assert.equal(result.offsets.length,65537);
  }
});
