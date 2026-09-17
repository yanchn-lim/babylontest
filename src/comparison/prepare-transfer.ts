import { repairSamples } from './sample-repair';
import { ComputeShader, StorageBuffer, UniformBuffer, type WebGPUEngine } from '@babylonjs/core';
import { geometry } from './surface-geometry';
import type { SceneData } from './main';
import { fixedLightData, transferBindings, transferFields, transferFingerprint, transferSourceFor,
  TRANSFER_SIZE, TRANSFER_PIXELS, TRANSFER_RAYS } from './transfer-data';

/** Offline tool entry point; ordinary viewers only download the prepared data. */
export async function prepareTransfer(data: SceneData, engine: WebGPUEngine, progress: (fraction: number) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now(), batch = 256;
  const mesh = geometry(data);
  const buffers: StorageBuffer[] = [];
  const allocations: Record<string, StorageBuffer> = {};
  const buffer = (name: string, value: ArrayBuffer | Float32Array | number) => {
    const result = new StorageBuffer(engine, typeof value === 'number' ? value : value.byteLength);
    if (typeof value !== 'number') result.update(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    buffers.push(result); allocations[name] = result;
  };
  const params = new UniformBuffer(engine);
  try {
    if (mesh.rayOrigins) buffer('rayOrigins', mesh.rayOrigins);
    buffer('nodes', mesh.nodes); buffer('triangles', mesh.triangles); buffer('surfaces', mesh.surfaces);
    buffer('surfaceLight', TRANSFER_PIXELS * 32); buffer('transfer', batch * TRANSFER_RAYS * 4);
    transferFields.forEach(name => params.addUniform(name, 4)); params.create();
    params.updateFloat4('sky', 0, 0, 0, TRANSFER_SIZE);
    data.fixtures.slice(0, 2).forEach((lamp, i) => params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity));
    const names = ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', 'transfer', ...(data.sampleRepair ? ['rayOrigins'] : [])];
    if (data.fixtures.length !== 2) { buffer('fixedLights', fixedLightData(data)); names.push('fixedLights'); }
    const shader = new ComputeShader('Prepare diffuse transfer', engine, { computeSource: transferSourceFor(data) }, {
      entryPoint: 'prepareTransfer',
      bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
    });
    for (const name of names) {
      if (name === 'params') shader.setUniformBuffer(name, params);
      else shader.setStorageBuffer(name, allocations[name]);
    }
    let failure = '';
    shader.onError = (_effect, error) => { failure = error; };
    const offsets = new Uint32Array(TRANSFER_PIXELS + 1), chunks: Uint32Array[] = [];
    const backfaces = new Uint16Array(TRANSFER_PIXELS);
    let entryCount = 0, representedHits = 0, activeSurfaces = 0;
    for (let start = 0; start < TRANSFER_PIXELS; start += batch) {
      signal?.throwIfAborted();
      const count = Math.min(batch, TRANSFER_PIXELS - start);
      params.updateFloat4('update', start, count, 0, 0); params.update();
      while (!shader.dispatch(Math.ceil(count / 64))) {
        signal?.throwIfAborted();
        if (failure) throw Error(failure);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const raw = await allocations.transfer.read(0, count * TRANSFER_RAYS * 4, undefined, true);
      signal?.throwIfAborted();
      const hits = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const packed: number[] = [];
      for (let row = 0; row < count; row++) {
        const index = start + row;
        offsets[index] = entryCount;
        if (mesh.surfaces[index * 12 + 3] === 0) continue;
        activeSurfaces++;
        const weights = new Map<number, number>();
        for (let ray = 0; ray < TRANSFER_RAYS; ray++) {
          const target = hits[row * TRANSFER_RAYS + ray];
          if (target === 0xfffffffe) { backfaces[index]++; continue; }
          if (target === 0xffffffff) continue;
          weights.set(target, (weights.get(target) || 0) + 1); representedHits++;
        }
        for (const [target, weight] of weights) packed.push((weight << 16) | target);
        entryCount += weights.size;
      }
      chunks.push(Uint32Array.from(packed)); progress((start + count) / TRANSFER_PIXELS);
    }
    offsets[TRANSFER_PIXELS] = entryCount;
    const raw = await allocations.surfaceLight.read(0, undefined, undefined, true);
    const light = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const visibility = new Float32Array(TRANSFER_PIXELS * 4);
    for (let i = 0; i < TRANSFER_PIXELS; i++) visibility.set(light.subarray(i * 8 + 4, i * 8 + 8), i * 4);
    if (data.sampleRepair) data = { ...data, sampleRepair: { ...data.sampleRepair,
      remap: repairSamples(data, mesh.surfaces, mesh.sampleFaces, backfaces) } };
    const bytes = new Uint8Array(64 + offsets.byteLength + visibility.byteLength + entryCount * 4);
    new Uint32Array(bytes.buffer, 0, 8).set([0x31544644, 1, TRANSFER_SIZE, TRANSFER_RAYS, entryCount]);
    bytes.set(await transferFingerprint(data), 32);
    bytes.set(new Uint8Array(offsets.buffer), 64);
    bytes.set(new Uint8Array(visibility.buffer), 64 + offsets.byteLength);
    let cursor = 64 + offsets.byteLength + visibility.byteLength;
    for (const chunk of chunks) { bytes.set(new Uint8Array(chunk.buffer), cursor); cursor += chunk.byteLength; }
    return { bytes, sceneData: data.sampleRepair ? data : undefined, stats: { atlasSize: TRANSFER_SIZE, rays: TRANSFER_RAYS, activeSurfaces,
      representedHits, entries: entryCount, bytes: bytes.byteLength, preparationMilliseconds: performance.now() - started } };
  } finally { buffers.forEach(value => value.dispose()); params.dispose(); }
}
