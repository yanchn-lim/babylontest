import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Mesh, NullEngine, PBRMaterial, Scene } from '@babylonjs/core';

registerHooks({ resolve(specifier, context, next) {
  if ((context.parentURL?.includes('/src/') || context.parentURL?.includes('/fixtures/')) && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { partitionLightingArchitecture } = await import('../src/apartment/lighting-intersections.ts');
const { generateLightingAtlas } = await import('../src/apartment/lighting-atlas.ts');
const { geometry } = await import('../src/comparison/surface-geometry.ts');
const { architecturalCharts } = await import('../src/apartment/lighting-charts.ts');
const { architecturalCharts: referenceCharts } = await import('./fixtures/lighting-charts-reference.ts');

function makeMesh(scene, name, positions, indices, normals) {
  const mesh = new Mesh(name, scene);
  mesh.setVerticesData('position', positions); mesh.setVerticesData('normal', normals);
  // Affine material coordinates must remain exact after subdivision.
  mesh.setVerticesData('uv', positions.flatMap((_, i) => i % 3 ? [] : [positions[i] * .3 + positions[i + 2], positions[i + 1] * .7]));
  mesh.setIndices(indices); mesh.material = new PBRMaterial(name, scene);
  return mesh;
}

test('intersection splitting preserves material coordinates and excludes glass and furniture', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const wall = makeMesh(scene, 'wall', [0,0,-1, 0,0,1, 0,2,1, 0,2,-1], [0,1,2,0,2,3], Array.from({ length:4 }, () => [-1,0,0]).flat());
    const blocker = makeMesh(scene, 'blocker', [-1,0,0, 0,0,0, 0,2,0, -1,2,0], [0,1,2,0,2,3], Array.from({ length:4 }, () => [0,0,1]).flat());
    const glass = makeMesh(scene, 'glass', [-1,0,.5, 0,0,.5, 0,2,.5], [0,1,2], [0,0,1,0,0,1,0,0,1]);
    glass.material.alpha = .5;
    const furniture = makeMesh(scene, 'furniture', [-1,0,-.5, 0,0,-.5, 0,2,-.5], [0,1,2], [0,0,1,0,0,1,0,0,1]);
    const untouched = [glass, furniture].map(mesh => ['position','normal','uv'].map(kind => [...mesh.getVerticesData(kind)]));
    const result = partitionLightingArchitecture([wall, blocker, glass]);
    assert.ok(result.partitionedTriangles > result.originalTriangles);
    assert.deepEqual([glass, furniture].map(mesh => ['position','normal','uv'].map(kind => [...mesh.getVerticesData(kind)])), untouched);
    for (const mesh of [wall, blocker]) {
      const p = mesh.getVerticesData('position'), uv = mesh.getVerticesData('uv');
      for (let i = 0; i < p.length / 3; i++) {
        assert.ok(Math.abs(uv[i*2] - (p[i*3]*.3 + p[i*3+2])) < 1e-6);
        assert.ok(Math.abs(uv[i*2+1] - p[i*3+1]*.7) < 1e-6);
      }
    }
    const p = wall.getVerticesData('position'), indices = wall.getIndices();
    for (let i = 0; i < indices.length; i += 3) {
      const z = indices.slice(i,i+3).map(id => p[id*3+2]);
      assert.ok(Math.min(...z) >= -1e-6 || Math.max(...z) <= 1e-6, 'No receiving triangle crosses the opaque wall.');
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test('apartment corner bilinear samples cannot blend the exterior into the living room', async () => {
  const data = JSON.parse(readFileSync(new URL('../public/apartment-transfer/scene.json', import.meta.url)));
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const meshes = data.meshes.map((mesh, i) => {
      const result = makeMesh(scene, 'architecture-'+i, mesh.positions, mesh.indices, mesh.normals);
      if (data.materials[mesh.material].transmitting) result.material.alpha = .5;
      return result;
    });
    partitionLightingArchitecture(meshes);
    const inputs = meshes.map((mesh, i) => ({
      positions: Array.from(mesh.getVerticesData('position')), normals: Array.from(mesh.getVerticesData('normal')),
      transmitting: !!data.materials[data.meshes[i].material].transmitting,
    }));
    const before = performance.now(), reference = referenceCharts(inputs, new Set()), referenceMilliseconds = performance.now() - before;
    const indexedAt = performance.now(), indexed = architecturalCharts(inputs, new Set()), indexedMilliseconds = performance.now() - indexedAt;
    assert.deepEqual(indexed, reference, 'Chart membership, order and coordinates remain exact.');
    console.log({ referenceChartMilliseconds:referenceMilliseconds, indexedChartMilliseconds:indexedMilliseconds });
    // Transparent meshes remain indexed and do not enter atlas rasterization.
    const atlas = await generateLightingAtlas(inputs, new Set(), { size:256 });
    data.surfaceInset = .008;
    data.meshes = inputs.map((mesh, i) => ({ ...mesh, material:data.meshes[i].material,
      indices:Array.from(meshes[i].getIndices()), uvs:atlas.atlas[i] }));
    const surfaces = geometry(data, true).surfaces, wall = data.meshes[4];
    for (const y of [.4, 1, 1.5, 2.3]) {
      const point = [-7.89, y]; let checked = false;
      for (let face = 0; face < wall.indices.length; face += 3) {
        const ids = wall.indices.slice(face, face+3);
        if (ids.some(i => Math.abs(wall.positions[i*3]-12.1) > 1e-5 || wall.normals[i*3] > -.99)) continue;
        const [a,b,c] = ids.map(i => [wall.positions[i*3+2], wall.positions[i*3+1]]);
        const area = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
        const u = ((b[1]-c[1])*(point[0]-c[0])+(c[0]-b[0])*(point[1]-c[1]))/area;
        const v = ((c[1]-a[1])*(point[0]-c[0])+(a[0]-c[0])*(point[1]-c[1]))/area;
        const w = [u,v,1-u-v]; if (Math.min(...w) < -1e-6) continue;
        const uv = [0,1].map(k => ids.reduce((sum,id,j) => sum + w[j]*wall.uvs[id*2+k],0)*256-.5);
        for (const dx of [0,1]) for (const dy of [0,1]) {
          const offset = ((Math.floor(uv[1])+dy)*256+Math.floor(uv[0])+dx)*12;
          assert.equal(surfaces[offset+3],1);
          assert.ok(surfaces[offset+4] < -.99);
          assert.ok(surfaces[offset+2] > -7.901, 'All four interpolation samples remain inside the room.');
        }
        checked = true; break;
      }
      assert.ok(checked, 'The original corner surface remains present.');
    }
  } finally { scene.dispose(); engine.dispose(); }
});
