import { Scene, WebGPUEngine } from '@babylonjs/core';
import { LightingAtlasCache, prepareLightingScene } from '../apartment/prepare-lighting-scene';
import { decodeTransfer, transferFingerprint } from '../comparison/transfer-data';
import type { PreparationTimings } from '../comparison/preparation-schedule';
import type { LightingLayout } from '../comparison/transfer-layout';
import { loadFixture } from './fixture';
import type { RunReport, WorkerRequest, WorkerReply } from './protocol';

let engine: WebGPUEngine | undefined, scene: Scene | undefined;
let fixture: Awaited<ReturnType<typeof loadFixture>> | undefined, controller: AbortController | undefined;
let previousLayout: LightingLayout | undefined;
const atlasCache = new LightingAtlasCache();
const send = (message: WorkerReply) => self.postMessage(message);
const hex = (bytes: Uint8Array) => Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'cancel') { controller?.abort(); return; }
  if (controller) { send({ type: 'error', id: data.id, message: 'A preparation job is already running.' }); return; }
  const { id, settings, base } = data, started = performance.now(), warm = !!fixture;
  const abort = new AbortController(); controller = abort;
  let stage = 'Loading', phaseStart = started, trialFinished = false, timings: PreparationTimings | undefined;
  const stages: Record<string, number> = {};
  let counts: RunReport['counts'];
  const progress = (next: string, fraction: number) => {
    if (next !== stage) { stages[stage] = performance.now() - phaseStart; phaseStart = performance.now(); stage = next; }
    send({ type: 'progress', id, stage, fraction, timings });
  };
  try {
    progress('Loading', 0);
    if (!fixture) {
      if (!await WebGPUEngine.IsSupportedAsync) throw Error('Lighting preparation requires WebGPU in this browser.');
      engine = new WebGPUEngine(new OffscreenCanvas(1, 1), { useExactSrgbConversions: true });
      await engine.initAsync(); scene = new Scene(engine); scene.useRightHandedSystem = true;
      fixture = await loadFixture(scene, base, true);
    }
    abort.signal.throwIfAborted();
    const selected = fixture.select(settings.layout, settings.placement); counts = selected.counts;
    const prepared = await prepareLightingScene({ ...selected, previousLayout, atlasCache, engine: engine!, signal: abort.signal,
      onProgress: (name, fraction) => progress({ scene: 'Materials', atlas: 'Atlas', transfer: 'Transfer' }[name], fraction),
      transferOptions: { strategy: settings.strategy, batchSize: settings.batchSize, pauseMilliseconds: settings.pauseMilliseconds,
        onBatch(value) {
          timings = value;
          if (settings.trial && value.processedSamples >= 4096) { trialFinished = true; abort.abort(); }
        },
      },
    });
    progress('Validation', 0); timings = prepared.stats.transfer.timings;
    await decodeTransfer(prepared.transferBytes.buffer, prepared.sceneData);
    const inputHash = hex(await transferFingerprint(prepared.sceneData));
    const outputHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', prepared.transferBytes)));
    abort.signal.throwIfAborted(); progress('Compression', 0);
    const gzip = new Uint8Array(await new Response(new Blob([prepared.transferBytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    abort.signal.throwIfAborted(); stages[stage] = performance.now() - phaseStart;
    previousLayout = prepared.sceneData.lightingLayout;
    const message: WorkerReply = { type: 'result', id, atlas: prepared.atlas, sceneData: prepared.sceneData, gzip,
      report: { ...settings, outcome: 'complete', totalMilliseconds: performance.now() - started, stages, timings,
        inputHash, outputHash, bytes: prepared.transferBytes.byteLength, warm, counts, atlasHeight: prepared.stats.atlas.height,
        atlasBuilds: prepared.stats.atlas.atlasBuilds, atlasCacheHits: prepared.stats.atlas.atlasCacheHits,
        packingAttempts: prepared.stats.atlas.packingAttempts, ignoredTriangles: prepared.stats.atlas.ignoredTriangles } };
    self.postMessage(message, { transfer: [gzip.buffer] });
  } catch (error) {
    stages[stage] = performance.now() - phaseStart;
    if (abort.signal.aborted) send({ type: 'result', id, report: { ...settings, outcome: trialFinished ? 'trial' : 'cancelled',
      totalMilliseconds: performance.now() - started, stages, timings, warm, counts } });
    else {
      send({ type: 'result', id, report: { ...settings, outcome: 'failed', error: error instanceof Error ? error.message : String(error),
        totalMilliseconds: performance.now() - started, stages, timings, warm, counts } });
      scene?.dispose(); engine?.dispose(); scene = undefined; engine = undefined; fixture = undefined; previousLayout = undefined;
      atlasCache.clear();
    }
  } finally { controller = undefined; }
};
