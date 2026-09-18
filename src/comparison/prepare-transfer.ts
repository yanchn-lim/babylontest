import { repairSamples } from './sample-repair';
import { preparationSchedule, pausePreparation, type PreparationTimings, type TransferPreparationOptions } from './preparation-schedule';
import { ComputeShader, StorageBuffer, UniformBuffer, type WebGPUEngine } from '@babylonjs/core';
import { geometry } from './surface-geometry';
import type { SceneData } from './main';
import { activeTransferSource } from './active-transfer';
import { transferLayout } from './transfer-layout';
import { TransferHitPacker } from './transfer-packing';
import { fixedLightData, transferBindings, transferFields, transferFingerprint, transferSourceFor,
  TRANSFER_RAYS } from './transfer-data';

/** Offline tool entry point; ordinary viewers only download the prepared data. */
export async function prepareTransfer(data: SceneData, engine: WebGPUEngine, progress: (fraction: number) => void, signal?: AbortSignal,
  options: TransferPreparationOptions = {}) {
  signal?.throwIfAborted();
  const { batchSize: batch, pauseMilliseconds } = preparationSchedule(options);
  const layout = transferLayout(data), n = layout.pixels;
  const active = (options.strategy ?? 'active') === 'active';
  const started = performance.now();
  const mesh = geometry(data);
  const indices = Uint32Array.from(Array.from({ length: n }, (_, i) => i).filter(i => mesh.surfaces[i * 12 + 3] !== 0));
  const workCount = active ? indices.length : n;
  const timings: PreparationTimings = { geometryMilliseconds: performance.now() - started, dispatchMilliseconds: 0,
    readbackMilliseconds: 0, packingMilliseconds: 0, pauseMilliseconds: 0, elapsedMilliseconds: 0,
    maxBatchMilliseconds: 0, batches: 0, processedSamples: 0, totalSamples: workCount, atlasPixels: n, activeSamples: 0, readbackBytes: 0 };
  const buffers: StorageBuffer[] = [];
  const allocations: Record<string, StorageBuffer> = {};
  const buffer = (name: string, value: ArrayBuffer | Float32Array | Uint32Array | number) => {
    const result = new StorageBuffer(engine, Math.max(4, typeof value === 'number' ? value : value.byteLength));
    if (typeof value !== 'number') result.update(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    buffers.push(result); allocations[name] = result;
  };
  const params = new UniformBuffer(engine);
  try {
    if (mesh.rayOrigins) buffer('rayOrigins', mesh.rayOrigins);
    buffer('nodes', mesh.nodes); buffer('triangles', mesh.triangles); buffer('surfaces', mesh.surfaces);
    buffer('surfaceLight', n * 32); buffer('transfer', batch * TRANSFER_RAYS * 4);
    if (active) buffer('activeIndices', indices);
    transferFields.forEach(name => params.addUniform(name, 4)); params.create();
    params.updateFloat4('sky', 0, 0, 0, layout.width);
    params.updateFloat4('dimensions', layout.height, 0, 0, 0);
    data.fixtures.slice(0, 2).forEach((lamp, i) => params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity));
    const names = ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', 'transfer', ...(data.sampleRepair ? ['rayOrigins'] : [])];
    if (data.fixtures.length !== 2) { buffer('fixedLights', fixedLightData(data)); names.push('fixedLights'); }
    if (active) names.push('activeIndices');
    const shader = new ComputeShader('Prepare diffuse transfer', engine, { computeSource: active ? activeTransferSource(data) : transferSourceFor(data) }, {
      entryPoint: active ? 'prepareActiveTransfer' : 'prepareTransfer',
      bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
    });
    for (const name of names) {
      if (name === 'params') shader.setUniformBuffer(name, params);
      else shader.setStorageBuffer(name, allocations[name]);
    }
    let failure = '';
    shader.onError = (_effect, error) => { failure = error; };
    const offsets = new Uint32Array(n + 1), chunks: Uint32Array[] = [];
    const backfaces = new Uint16Array(n);
    const packer = new TransferHitPacker(n, layout.bits), packed = new Uint32Array(batch * TRANSFER_RAYS);
    let entryCount = 0, representedHits = 0, activeSurfaces = 0, nextOffset = 0;
    for (let start = 0; start < workCount; start += batch) {
      signal?.throwIfAborted();
      const batchStarted = performance.now();
      const count = Math.min(batch, workCount - start);
      params.updateFloat4('update', start, count, 0, 0); params.update();
      while (!shader.dispatch(active ? count : Math.ceil(count / 64))) {
        signal?.throwIfAborted();
        if (failure) throw Error(failure);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const dispatched = performance.now();
      timings.dispatchMilliseconds += dispatched - batchStarted;
      const raw = await allocations.transfer.read(0, count * TRANSFER_RAYS * 4, undefined, true);
      const read = performance.now();
      timings.readbackMilliseconds += read - dispatched;
      timings.readbackBytes += count * TRANSFER_RAYS * 4;
      signal?.throwIfAborted();
      const hits = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let packedCount = 0;
      for (let row = 0; row < count; row++) {
        const index = active ? indices[start + row] : start + row;
        offsets.fill(entryCount, nextOffset, index + 1); nextOffset = index + 1;
        if (mesh.surfaces[index * 12 + 3] === 0) continue;
        activeSurfaces++;
        const count = packer.pack(hits, row * TRANSFER_RAYS, packed, packedCount);
        packedCount += count; entryCount += count;
        backfaces[index] = packer.backfaces; representedHits += packer.representedHits;
        if (entryCount > 0xffffffff) throw Error('Diffuse transfer exceeds the cache address range.');
      }
      chunks.push(packed.slice(0, packedCount));
      timings.packingMilliseconds += performance.now() - read;
      timings.maxBatchMilliseconds = Math.max(timings.maxBatchMilliseconds, performance.now() - batchStarted);
      timings.batches++; timings.processedSamples = start + count; timings.activeSamples = activeSurfaces;
      timings.elapsedMilliseconds = performance.now() - started;
      options.onBatch?.({ ...timings });
      signal?.throwIfAborted(); progress((start + count) / workCount);
      if (pauseMilliseconds && start + count < workCount) {
        const pauseStarted = performance.now();
        await pausePreparation(pauseMilliseconds, signal);
        timings.pauseMilliseconds += performance.now() - pauseStarted;
      }
    }
    offsets.fill(entryCount, nextOffset);
    const raw = await allocations.surfaceLight.read(0, undefined, undefined, true);
    const light = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const visibility = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) visibility.set(light.subarray(i * 8 + 4, i * 8 + 8), i * 4);
    if (data.sampleRepair) data = { ...data, sampleRepair: { ...data.sampleRepair,
      remap: repairSamples(data, mesh.surfaces, mesh.sampleFaces, backfaces) } };
    const bytes = new Uint8Array(64 + offsets.byteLength + visibility.byteLength + entryCount * 4);
    new Uint32Array(bytes.buffer, 0, 8).set([0x31544644, layout.version, layout.width, TRANSFER_RAYS, entryCount,
      ...(layout.version === 2 ? [layout.height, layout.bits] : [])]);
    bytes.set(await transferFingerprint(data), 32);
    bytes.set(new Uint8Array(offsets.buffer), 64);
    bytes.set(new Uint8Array(visibility.buffer), 64 + offsets.byteLength);
    let cursor = 64 + offsets.byteLength + visibility.byteLength;
    for (const chunk of chunks) { bytes.set(new Uint8Array(chunk.buffer), cursor); cursor += chunk.byteLength; }
    timings.elapsedMilliseconds = performance.now() - started;
    return { bytes, sceneData: data.sampleRepair ? data : undefined, stats: { atlasSize: layout.width, atlasHeight: layout.height, rays: TRANSFER_RAYS, activeSurfaces,
      batchSize: batch, timings,
      representedHits, entries: entryCount, bytes: bytes.byteLength, preparationMilliseconds: performance.now() - started } };
  } finally { buffers.forEach(value => value.dispose()); params.dispose(); }
}
