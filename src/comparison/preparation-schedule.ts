import type { LightingPreviewOptions } from './streaming-preview';

export interface PreparationTimings {
  geometryMilliseconds: number;
  dispatchMilliseconds: number;
  readbackMilliseconds: number;
  packingMilliseconds: number;
  pauseMilliseconds: number;
  elapsedMilliseconds: number;
  maxBatchMilliseconds: number;
  batches: number;
  processedSamples: number;
  totalSamples: number;
  atlasPixels: number;
  activeSamples: number;
  readbackBytes: number;
  pipelinedBatches?: number;
  previewSamples?: number;
  refinementRays?: number;
  refinementPasses?: { rays: number; milliseconds: number }[];
}

export interface TransferPreparationOptions {
  strategy?: 'active' | 'reference';
  batchSize?: number;
  pauseMilliseconds?: number;
  onBatch?: (timings: PreparationTimings) => void;
  /** Read between batches. Batch size cannot exceed the initial allocation. */
  schedule?: () => { batchSize: number; pauseMilliseconds: number };
  preview?: LightingPreviewOptions;
}

export function interactiveSchedule(frameMilliseconds: number, maxBatch: number, minPause: number) {
  const busy = frameMilliseconds > 24;
  return preparationSchedule({ batchSize: Math.min(maxBatch, busy ? 128 : 512),
    pauseMilliseconds: Math.max(minPause, busy ? 32 : 8) });
}

export function preparationSchedule(options: TransferPreparationOptions = {}) {
  if (options.strategy !== undefined && !['active', 'reference'].includes(options.strategy)) throw Error('Unknown transfer preparation strategy.');
  const batchSize = options.batchSize ?? 256, pauseMilliseconds = options.pauseMilliseconds ?? 0;
  if (!Number.isInteger(batchSize) || batchSize < 64 || batchSize > 4096 || batchSize % 64) throw Error('Batch size must be a multiple of 64 between 64 and 4096.');
  if (!Number.isFinite(pauseMilliseconds) || pauseMilliseconds < 0 || pauseMilliseconds > 100) throw Error('Batch pause must be between 0 and 100 ms.');
  return { batchSize, pauseMilliseconds };
}

export function pausePreparation(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!milliseconds) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
