import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/src/apartment/') && specifier.startsWith('./') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { architecturalCharts } = await import('../src/apartment/lighting-charts.ts');
const { generateLightingAtlas, validateLightingAtlas } = await import('../src/apartment/lighting-atlas.ts');

function quad(points, normal) {
  const order = [0, 1, 2, 0, 2, 3];
  return { positions: order.flatMap(i => points[i]), normals: order.flatMap(() => normal), transmitting: false };
}
const floor = (left, right, end = 1) => quad([[left, 0, 0], [right, 0, 0], [right, 0, end], [left, 0, end]], [0, 1, 0]);
const wall = () => quad([[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], [1, 0, 0]);
const bounds = uv => [0, 1].map(k => [Math.min(...uv.filter((_, i) => i % 2 === k)), Math.max(...uv.filter((_, i) => i % 2 === k))]);

test('coplanar floor joins across a mesh boundary, but an opaque wall splits it', () => {
  const floors = [floor(-1, 0), floor(0, 1)];
  assert.equal(architecturalCharts(floors, new Set()).length, 1);
  const charts = architecturalCharts([...floors, wall()], new Set());
  assert.equal(charts.length, 3);
  assert.ok(charts.every(chart => new Set(chart.faces.map(face => face.mesh)).size === 1));
  assert.equal(architecturalCharts([...floors, { ...wall(), transmitting: true }], new Set()).length, 1);
});

test('partial shared edges join at T-junctions; disconnected floor regions stay separate', () => {
  assert.equal(architecturalCharts([floor(-1, 0, 2), floor(0, 1)], new Set()).length, 1);
  assert.equal(architecturalCharts([floor(-1, 0), floor(1, 2)], new Set()).length, 2);
});

test('final packing retains wall separation and filter padding without changing the source', async () => {
  const geometry = [floor(-1, 0), floor(0, 1), wall()], before = structuredClone(geometry);
  const result = await generateLightingAtlas(geometry, new Set(), { size: 256 });
  assert.equal(result.stats.architectureCharts, 3);
  const [a, b] = result.atlas.slice(0, 2).map(bounds);
  const gap = Math.max(...a.map(([lo, hi], k) => Math.max(b[k][0] - hi, lo - b[k][1])));
  assert.ok(gap * 256 >= 2, 'Rooms must have distinct padded atlas regions.');
  assert.deepEqual(geometry, before);
});

test('validation rejects overlapping chart interiors and non-finite coordinates', () => {
  const geometry = [floor(-1, 0), floor(0, 1)], uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  assert.throws(() => validateLightingAtlas(geometry, [uv, uv], [[0, 0], [1, 1]], 256), /overlap/);
  assert.throws(() => validateLightingAtlas([geometry[0]], [[NaN, ...uv.slice(1)]], [[0, 0]], 256), /Invalid/);
  assert.throws(() => validateLightingAtlas([geometry[0]], [new Array(12).fill(0)], [[-1, -1]], 256), /no lighting chart/);
  assert.throws(() => validateLightingAtlas([geometry[0]], [new Array(12).fill(0)], [[0, 0]], 256), /collapsed.*mesh 0, face 0/);
});

test('zero-area furniture faces keep their UV slots without displacing valid faces', async () => {
  const positions = [0,0,0, 1,0,0, 0,0,1, 2,0,0, 3,0,0, 4,0,0, 5,0,0, 6,0,0, 5,0,1];
  const mesh = { positions, normals: Array.from({ length: 9 }, () => [0,1,0]).flat(), transmitting: false };
  const before = structuredClone(mesh);
  const result = await generateLightingAtlas([mesh], new Set([0]), { size: 256 });
  assert.equal(result.stats.ignoredTriangles, 1);
  assert.equal(result.atlas[0].length, 18);
  assert.deepEqual(result.atlas[0].slice(6, 12), [0,0,0,0,0,0]);
  assert.ok(result.atlas[0].slice(0, 6).some(v => v > 0));
  assert.ok(result.atlas[0].slice(12).some(v => v > 0));
  assert.deepEqual(mesh, before);
  const empty = { ...mesh, positions: positions.slice(9, 18), normals: mesh.normals.slice(9, 18) };
  await assert.rejects(generateLightingAtlas([empty], new Set([0]), { size: 256 }), /No opaque lighting geometry/);
  const mixed = await generateLightingAtlas([empty, mesh], new Set([0, 1]), { size: 256 });
  assert.deepEqual(mixed.atlas[0], [0,0,0,0,0,0]);
  assert.equal(mixed.stats.ignoredTriangles, 2);
});

test('original APPLARYD at the two failing rotations retains all UV slots and excludes five zero-area faces', async () => {
  const data = JSON.parse(readFileSync(new URL('../public/comparison/applaryd/scene.json', import.meta.url)));
  for (const angle of [30, 135]) {
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const rotate = ([x,y,z], translate) => [x*c+z*s+(translate ? 10 : 0), y, -x*s+z*c-(translate ? 7 : 0)];
    const geometry = data.meshes.slice(2).map(mesh => ({
      positions: mesh.indices.flatMap(i => rotate(mesh.positions.slice(i*3,i*3+3), true)),
      normals: mesh.indices.flatMap(i => rotate(mesh.normals.slice(i*3,i*3+3), false)), transmitting: false,
    }));
    const before = structuredClone(geometry);
    const result = await generateLightingAtlas(geometry, new Set(geometry.map((_,i) => i)), { size: 256 });
    assert.equal(result.stats.ignoredTriangles, 5);
    assert.deepEqual(geometry, before);
    result.atlas.forEach((uv,i) => assert.equal(uv.length, geometry[i].positions.length / 3 * 2));
  }
});

test('insufficient atlas space fails instead of removing chart padding', async () => {
  const regions = Array.from({ length: 32 }, (_, i) => floor(i * 2, i * 2 + 1));
  await assert.rejects(generateLightingAtlas(regions, new Set(), { size: 8 }), /capacity/);
});

test('pre-aborted work and invalid geometry fail without returning an atlas', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateLightingAtlas([floor(0, 1)], new Set(), { size: 256, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(generateLightingAtlas([floor(0, 1)], new Set([4]), { size: 256 }), /Invalid furniture/);
  await assert.rejects(generateLightingAtlas([{ ...floor(0, 1), positions: [NaN] }], new Set(), { size: 256 }), /Invalid lighting geometry/);
});

test('actual apartment and 7,628-triangle APPLARYD fit one validated 256px atlas', async () => {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const apartment = read('../public/apartment-transfer/scene.json');
  const sofa = read('../public/comparison/applaryd/scene.json');
  const expand = (mesh, data) => ({
    positions: mesh.indices.flatMap(i => mesh.positions.slice(i * 3, i * 3 + 3)),
    normals: mesh.indices.flatMap(i => mesh.normals.slice(i * 3, i * 3 + 3)),
    transmitting: !!data.materials[mesh.material].transmitting,
  });
  const geometry = apartment.meshes.map(mesh => expand(mesh, apartment));
  const furniture = new Set();
  sofa.meshes.slice(2).forEach(mesh => { furniture.add(geometry.length); geometry.push(expand(mesh, sofa)); });
  const started = performance.now();
  const result = await generateLightingAtlas(geometry, furniture, { size: 256 });
  assert.equal(result.atlas.length, geometry.length);
  assert.ok(result.stats.architectureCharts > 322, 'Keep connected wall-separated charts, not just 322 geometric planes.');
  result.atlas.forEach((uv, i) => assert.equal(uv.length, geometry[i].positions.length / 3 * 2));
  console.log('Apartment + APPLARYD atlas:', result.stats, Math.round(performance.now() - started), 'ms');
});
