import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { NullEngine, Scene, MeshBuilder, PBRMaterial, Vector3 } from '@babylonjs/core';

// Only GPU execution is replaced here; scene extraction, transforms and xatlas are real.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@babylonjs/loaders/glTF') return next('@babylonjs/loaders/glTF/index.js', context);
  if (context.parentURL?.endsWith('/prepare-lighting-scene.ts') && specifier.endsWith('/prepare-transfer')) {
    return { url: 'data:text/javascript,export const prepareTransfer=(...args)=>globalThis.testLightingTransfer(...args)', shortCircuit: true };
  }
  if (specifier.endsWith('.wgsl?raw')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.wgsl?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(new URL(url.replace('?raw', '')), 'utf8')), shortCircuit: true };
  return next(url, context);
} });
const { prepareLightingScene } = await import('../src/apartment/prepare-lighting-scene.ts');
const { prepareScene } = await import('../src/apartment/prepare-scene.ts');
const settings = { sky: [.48, .65, 1], fixtures: [{ position: [0, 2, 0], color: [1, .72, .45], intensity: 7 }], views: {} };

async function setup(run) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('Furniture', {}, scene);
  mesh.material = new PBRMaterial('Fabric', scene); mesh.material.metallic = 0;
  mesh.position.set(3, 0, -2); mesh.scaling.set(-2, 1, 1);
  try { await run(mesh, scene); } finally { scene.dispose(); engine.dispose(); delete globalThis.testLightingTransfer; }
}

test('one API returns matching triangle-order atlas, transformed geometry and transfer bytes', () => setup(async mesh => {
  const original = { position: [...mesh.getVerticesData('position')], uv: [...mesh.getVerticesData('uv')], indices: [...mesh.getIndices()] };
  const stages = [];
  globalThis.testLightingTransfer = async (data, _engine, progress, signal) => {
    assert.equal(data.meshes[0].positions.length, original.indices.length * 3);
    assert.equal(data.meshes[0].uvs.length, original.indices.length * 2);
    assert.equal(signal, undefined); progress(1);
    return { bytes: new Uint8Array([1, 2, 3]), stats: { entries: 3 } };
  };
  const result = await prepareLightingScene({ meshes: [mesh], furnitureMeshes: new Set([mesh]), settings,
    engine: { isWebGPU: true }, onProgress: stage => stages.push(stage) });
  assert.deepEqual(result.atlas[0], result.sceneData.meshes[0].uvs);
  assert.deepEqual(result.transferBytes, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...new Set(stages)], ['scene', 'atlas', 'transfer']);
  const p = result.sceneData.meshes[0].positions;
  for (let corner = 0; corner < original.indices.length; corner++) {
    const expected = Vector3.TransformCoordinates(Vector3.FromArray(original.position, original.indices[corner] * 3), mesh.getWorldMatrix()).asArray();
    assert.deepEqual(p.slice(corner * 3, corner * 3 + 3), expected);
  }
  assert.deepEqual(result.sceneData.meshes[0].indices.slice(0, 3), [0, 2, 1], 'Negative scale preserves winding.');
  assert.deepEqual([...mesh.getVerticesData('position')], original.position);
  assert.deepEqual([...mesh.getVerticesData('uv')], original.uv);
  assert.deepEqual([...mesh.getIndices()], original.indices);
  assert.equal(mesh.getVerticesData('uv3'), null);
}));

test('cancellation between atlas and transfer does not install partial data', () => setup(async mesh => {
  const controller = new AbortController(); let called = false;
  globalThis.testLightingTransfer = async () => { called = true; controller.signal.throwIfAborted(); };
  await assert.rejects(prepareLightingScene({ meshes: [mesh], furnitureMeshes: new Set([mesh]), settings,
    engine: { isWebGPU: true }, signal: controller.signal,
    onProgress: (stage, value) => { if (stage === 'atlas' && value === 1) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(called, false);
  assert.equal(mesh.getVerticesData('uv3'), null);
}));

test('unsupported engines and invalid ownership fail before GPU preparation', () => setup(async mesh => {
  const input = { meshes: [mesh], furnitureMeshes: new Set(), settings, engine: { isWebGPU: false } };
  await assert.rejects(prepareLightingScene(input), /requires WebGPU/);
  await assert.rejects(prepareLightingScene({ ...input, engine: { isWebGPU: true }, furnitureMeshes: new Set([{}]) }), /Invalid lighting mesh list/);
  await assert.rejects(prepareLightingScene({ ...input, engine: { isWebGPU: true }, settings: { ...settings, fixtures: [] } }), /one to eight/);
}));

test('existing prepareScene callers keep their indexed uv3 contract', () => setup(async mesh => {
  const uv = [...mesh.getVerticesData('uv')]; mesh.setVerticesData('uv3', uv);
  const result = await prepareScene([mesh], [mesh.material], settings);
  assert.equal(result.meshes[0].positions.length, mesh.getVerticesData('position').length);
  assert.deepEqual(result.meshes[0].uvs, uv);
}));
