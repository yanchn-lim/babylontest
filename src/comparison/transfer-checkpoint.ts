import { workBudget } from './work-budget';
import type { SceneData } from './main';
import { transferLayout } from './transfer-layout';

/** Transient partial transport; never serialized as a completed cache. */
export interface TransferCheckpoint {
  rays: 64 | 128 | 256 | 512;
  offsets: Uint32Array;
  entries: Uint32Array;
  visibility: Float32Array;
}

export async function validateCheckpoint(value: TransferCheckpoint, data: SceneData, yieldWork: () => Promise<void>, countHits = false) {
  const { pixels, bits, mask } = transferLayout(data);
  const { rays, offsets, entries, visibility } = value;
  if (![64, 128, 256, 512].includes(rays) || !(offsets instanceof Uint32Array) || !(entries instanceof Uint32Array)
    || !(visibility instanceof Float32Array) || offsets.length !== pixels + 1 || visibility.length !== pixels * 4
    || offsets[0] !== 0 || offsets[pixels] !== entries.length) throw Error('Invalid lighting checkpoint.');
  const frontHits = countHits ? new Uint16Array(pixels) : undefined, pause = workBudget(yieldWork);
  for (let i = 0; i < pixels; i++) {
    if (i % 128 === 0) { const pending = pause(); if (pending) await pending; }
    if (offsets[i] > offsets[i + 1] || offsets[i + 1] > entries.length) throw Error('Invalid checkpoint offsets.');
    let hits = 0;
    for (let j = offsets[i]; j < offsets[i + 1]; j++) {
      const weight = entries[j] >>> bits;
      if (!weight || (entries[j] & mask) >= pixels) throw Error('Invalid checkpoint connection.');
      hits += weight;
    }
    if (hits > rays) throw Error('Checkpoint exceeds its ray count.');
    if (frontHits) frontHits[i] = hits;
    for (let c = 0; c < 4; c++) {
      const v = visibility[i * 4 + c];
      if (!Number.isFinite(v) || v < 0 || v > (c === 3 && data.fixtures.length !== 2 ? 255 : 1)) throw Error('Invalid checkpoint visibility.');
    }
  }
  return { ...value, frontHits };
}
