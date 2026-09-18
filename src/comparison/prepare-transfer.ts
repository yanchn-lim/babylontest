import { repairSamples } from './sample-repair';
import { preparationSchedule, pausePreparation, type PreparationTimings, type TransferPreparationOptions } from './preparation-schedule';
import { ComputeShader, StorageBuffer, UniformBuffer, type WebGPUEngine } from '@babylonjs/core';
import { geometry } from './surface-geometry';
import type { SceneData } from './main';
import { activeTransferSource } from './active-transfer';
import { transferLayout } from './transfer-layout';
import { transferRayDistance } from './ray-distance';
import { TransferHitPacker, transferVisibility } from './transfer-packing';
import { ProgressiveHitPacker, ProgressiveRows } from './progressive-transfer';
import { previewSources, StreamingPreview } from './streaming-preview';
import { fixedLightData, transferBindings, transferFields, transferFingerprint, transferSourceFor,
  TRANSFER_RAYS } from './transfer-data';

/** Offline tool entry point; ordinary viewers only download the prepared data. */
export async function prepareTransfer(data: SceneData, engine: WebGPUEngine, progress: (fraction: number) => void, signal?: AbortSignal,
  options: TransferPreparationOptions = {}) {
  signal?.throwIfAborted();
  const rayDistance = transferRayDistance(data);
  const { batchSize: batch, pauseMilliseconds } = preparationSchedule(options);
  const layout = transferLayout(data), n = layout.pixels;
  const active = (options.strategy ?? 'active') === 'active';
  const progressive = !!options.preview?.progressive;
  if (options.preview?.onCheckpoint && !progressive) throw Error('Lighting checkpoints require progressive baking.');
  if (progressive && (!active || data.sampleRepair)) throw Error('Progressive baking requires active samples without sample repair.');
  const started = performance.now();
  const mesh = geometry(data);
  const indices = Uint32Array.from(Array.from({ length: n }, (_, i) => i).filter(i => mesh.surfaces[i * 12 + 3] !== 0));
  const workCount = active ? indices.length : n;
  const timings: PreparationTimings = { geometryMilliseconds: performance.now() - started, dispatchMilliseconds: 0,
    readbackMilliseconds: 0, packingMilliseconds: 0, pauseMilliseconds: 0, elapsedMilliseconds: 0,
    maxBatchMilliseconds: 0, batches: 0, pipelinedBatches: 0, previewSamples: 0, processedSamples: 0, totalSamples: workCount, atlasPixels: n, activeSamples: 0, readbackBytes: 0 };
  const buffers: StorageBuffer[] = [];
  const allocations: Record<string, StorageBuffer> = {};
  const buffer = (name: string, value: ArrayBuffer | Float32Array | Uint32Array | number) => {
    const result = new StorageBuffer(engine, Math.max(4, typeof value === 'number' ? value : value.byteLength));
    if (typeof value !== 'number') result.update(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    buffers.push(result); allocations[name] = result;
  };
  const params = new UniformBuffer(engine);
  let pendingRead: Promise<unknown> | undefined;
  try {
    if (mesh.rayOrigins) buffer('rayOrigins', mesh.rayOrigins);
    buffer('nodes', mesh.nodes); buffer('triangles', mesh.triangles); buffer('surfaces', mesh.surfaces);
    buffer('surfaceLight', n * 32); buffer('transfer', batch * TRANSFER_RAYS * 4);
    if (active) buffer('activeIndices', indices);
    transferFields.forEach(name => params.addUniform(name, 4)); params.create();
    params.updateFloat4('sky', 0, 0, 0, layout.width);
    params.updateFloat4('dimensions', layout.height, 0, 0, 0);
    params.updateFloat4('origin', 0, 0, 0, rayDistance);
    data.fixtures.slice(0, 2).forEach((lamp, i) => params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity));
    data.fixtures.slice(0, 2).forEach((lamp, i) => params.updateFloat4('lampColor' + i, ...lamp.color, 0));
    const names = ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', 'transfer', ...(data.sampleRepair ? ['rayOrigins'] : [])];
    if (data.fixtures.length !== 2) { buffer('fixedLights', fixedLightData(data)); names.push('fixedLights'); }
    if (active) names.push('activeIndices');
    let preview = options.preview ? new StreamingPreview(data,
      await previewSources(data, engine, params, allocations, options.preview, signal), options.preview.state.sky) : undefined;
    const shader = new ComputeShader('Prepare diffuse transfer', engine, { computeSource: active ? activeTransferSource(data, progressive) : transferSourceFor(data) }, {
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
    const packer = new TransferHitPacker(n, layout.bits);
    const progressivePacker = progressive ? new ProgressiveHitPacker(n, layout.bits) : undefined;
    const packed = new Uint32Array((progressive ? 4096 : batch) * TRANSFER_RAYS);
    const firstRays = progressive ? new Uint16Array(packed.length) : undefined;
    let previous: ProgressiveRows | undefined, rayStart = 0;
    let entryCount = 0, representedHits = 0, activeSurfaces = 0, nextOffset = 0;
    if (progressive) timings.refinementPasses = [];
    for (const rayEnd of progressive ? [64, 128, 256, 512, 1024] : [1024]) {
      const rayCount = rayEnd - rayStart, final = rayEnd === TRANSFER_RAYS;
      const partial = progressive && !final ? new ProgressiveRows() : undefined;
      if (progressive) timings.refinementRays = rayEnd;
      // Preview patches read shared visibility, so overlap only after that stream ends.
      const pipeline = progressive && !preview;
      if (pipeline && !allocations.transferNext) buffer('transferNext', batch * TRANSFER_RAYS * 4);
      const submit = async (start: number, slot: number) => {
        signal?.throwIfAborted();
        const schedule = options.schedule ? preparationSchedule(options.schedule()) : { batchSize: batch, pauseMilliseconds };
        if (schedule.batchSize > batch) throw Error('Scheduled batch exceeds the allocated batch size.');
        const batchStarted = performance.now();
        const capacity = progressive ? Math.min(4096, Math.floor(schedule.batchSize * TRANSFER_RAYS / rayCount / 64) * 64) : schedule.batchSize;
        const count = Math.min(capacity, workCount - start), target = slot ? allocations.transferNext : allocations.transfer;
        shader.setStorageBuffer('transfer', target);
        params.updateFloat4('update', start, count, 0, 0);
        if (progressive) params.updateFloat4('range', rayStart, rayEnd, 0, 0);
        params.update();
        while (!shader.dispatch(active ? count : Math.ceil(count / 64))) {
          signal?.throwIfAborted();
          if (failure) throw Error(failure);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        timings.dispatchMilliseconds += performance.now() - batchStarted;
        // read(..., true) submits the dispatch and its copy before params can change.
        const readback = target.read(0, count * rayCount * 4, undefined, true);
        pendingRead = readback;
        void readback.catch(() => {}); // The owning batch or cleanup handles rejection.
        timings.readbackBytes += count * rayCount * 4;
        return { start, count, slot, schedule, batchStarted, readback };
      };
      const pause = async (milliseconds: number) => {
        if (!milliseconds) return;
        const started = performance.now();
        await pausePreparation(milliseconds, signal);
        timings.pauseMilliseconds += performance.now() - started;
      };
      let current = workCount ? await submit(0, 0) : undefined;
      while (current) {
        const { start, count, slot, schedule, batchStarted } = current;
        const waiting = performance.now();
        const raw = await current.readback;
        pendingRead = undefined;
        timings.readbackMilliseconds += performance.now() - waiting;
        signal?.throwIfAborted();
        const nextStart = start + count;
        let next: typeof current | undefined;
        if (pipeline && nextStart < workCount) {
          await pause(schedule.pauseMilliseconds);
          next = await submit(nextStart, 1 - slot);
          timings.pipelinedBatches!++;
        }
        const read = performance.now();
        const hits = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        const rowOffsets = partial ? new Uint32Array(count + 1) : undefined;
        let packedCount = 0;
        for (let row = 0; row < count; row++) {
          const index = active ? indices[start + row] : start + row;
          if (final) { offsets.fill(entryCount, nextOffset, index + 1); nextOffset = index + 1; }
          if (mesh.surfaces[index * 12 + 3] === 0) continue;
          const length = progressivePacker
            ? progressivePacker.pack(hits, row * rayCount, rayStart, rayEnd, packed, firstRays!, packedCount, previous?.take(start + row))
            : packer.pack(hits, row * TRANSFER_RAYS, packed, packedCount);
          const frontHits = (progressivePacker ?? packer).representedHits;
          if (preview) { preview.add(index, packed, packedCount, length, frontHits, rayEnd); timings.previewSamples!++; }
          packedCount += length;
          if (rowOffsets) rowOffsets[row + 1] = packedCount;
          if (final) {
            activeSurfaces++; entryCount += length; representedHits += frontHits;
            backfaces[index] = packer.backfaces;
            if (entryCount > 0xffffffff) throw Error('Diffuse transfer exceeds the cache address range.');
          }
        }
        if (partial) partial.add(start, rowOffsets!, packed.slice(0, packedCount), firstRays!.slice(0, packedCount));
        else chunks.push(packed.slice(0, packedCount));
        timings.packingMilliseconds += performance.now() - read;
        timings.maxBatchMilliseconds = Math.max(timings.maxBatchMilliseconds, performance.now() - batchStarted);
        const processed = (rayStart * workCount + (start + count) * rayCount) / TRANSFER_RAYS;
        timings.batches++; timings.processedSamples = processed; timings.activeSamples = activeSurfaces;
        timings.elapsedMilliseconds = performance.now() - started;
        options.onBatch?.({ ...timings });
        signal?.throwIfAborted(); progress(processed / workCount);
        if (preview) await preview.flush(allocations.surfaceLight, processed / workCount, options.preview!.onChunk, signal, nextStart === workCount, rayEnd);
        if (!pipeline && nextStart < workCount) {
          await pause(schedule.pauseMilliseconds);
          next = await submit(nextStart, 0);
        }
        current = next;
      }
      if (progressive) timings.refinementPasses!.push({ rays: rayEnd, milliseconds: performance.now() - started });
      if (partial && options.preview?.onCheckpoint) {
        const raw = await allocations.surfaceLight.read(0, undefined, undefined, true);
        const light = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        const visibility = transferVisibility(light);
        signal?.throwIfAborted();
        await options.preview.onCheckpoint({ rays: rayEnd as 64 | 128 | 256 | 512, ...partial.snapshot(indices, n), visibility });
        signal?.throwIfAborted();
        preview = undefined;
      }
      previous = partial; rayStart = rayEnd;
    }
    offsets.fill(entryCount, nextOffset);
    const raw = await allocations.surfaceLight.read(0, undefined, undefined, true);
    const light = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const visibility = transferVisibility(light);
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
  } finally {
    // At most one submitted read remains after cancellation or a packing error.
    try { await pendingRead; } catch { /* Preserve the original failure. */ }
    buffers.forEach(value => value.dispose()); params.dispose();
  }
}
