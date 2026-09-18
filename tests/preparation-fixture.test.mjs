import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { furniturePlacements } from '../src/preparation/furnishings.ts';
registerHooks({ resolve(s,c,n) {
  if (c.parentURL?.includes('/src/apartment/') && s.startsWith('./') && !s.endsWith('.ts')) return n(s+'.ts',c);
  return n(s,c);
} });
const { generateLightingAtlas } = await import('../src/apartment/lighting-atlas.ts');
const apartment = JSON.parse(readFileSync(new URL('../public/apartment-transfer/scene.json', import.meta.url)));
const sofa = JSON.parse(readFileSync(new URL('../public/comparison/applaryd/scene.json', import.meta.url)));
const expand = (mesh,data) => ({ positions: mesh.indices.flatMap(i => mesh.positions.slice(i*3,i*3+3)),
  normals: mesh.indices.flatMap(i => mesh.normals.slice(i*3,i*3+3)), transmitting: !!data.materials[mesh.material].transmitting });

test('IKEA fixture uses original verified GLBs below the selected triangle budget', () => {
  const base = new URL('../public/preparation/ikea/',import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
  assert.equal(furniturePlacements.length,18);
  assert.equal(manifest.products.length,9);
  let placedTriangles=0;
  for (const product of manifest.products) {
    const bytes=readFileSync(new URL(product.article+'.glb',base));
    assert.equal(bytes.readUInt32LE(0),0x46546c67);
    assert.equal(bytes.readUInt32LE(8),bytes.length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),product.sha256);
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    let triangles=0;
    const visit=index=>{
      const node=gltf.nodes[index];
      if(node.mesh!==undefined) for(const primitive of gltf.meshes[node.mesh].primitives) {
        assert.equal(primitive.mode??4,4);
        triangles+=gltf.accessors[primitive.indices??primitive.attributes.POSITION].count/3;
      }
      for(const child of node.children??[]) visit(child);
    };
    gltf.scenes[gltf.scene??0].nodes.forEach(visit);
    assert.equal(triangles,product.triangles);
    assert.ok(triangles>0&&triangles<=3000);
    assert.ok(gltf.materials.length>0&&gltf.textures.length>0);
    placedTriangles+=triangles*furniturePlacements.filter(item=>item[0]===product.article).length;
  }
  assert.ok(furniturePlacements.every(item=>manifest.products.some(product=>product.article===item[0])));
  assert.equal(placedTriangles,28550);
});

test('three detailed sofas retain an explicit capacity failure, not a collapsed-triangle failure', async () => {
  const geometry = apartment.meshes.map(mesh => expand(mesh,apartment)), furniture = new Set();
  for (const x of [10,1.5,4.5]) for (const mesh of sofa.meshes.slice(2)) {
    const data = expand(mesh,sofa); data.positions = data.positions.map((v,i) => v+(i%3===0 ? x : i%3===2 ? -6.7 : 0));
    furniture.add(geometry.length); geometry.push(data);
  }
  await assert.rejects(generateLightingAtlas(geometry,furniture,{size:256}), /256px lighting atlas capacity/);
});
