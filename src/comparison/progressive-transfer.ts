import { packTransferEntry } from './transfer-layout';

/** Visit every original direction once; the first 64 cover the full hemisphere. */
const rayOrder = Uint16Array.from({ length: 1024 }, (_, index) => {
  let reversed = 0;
  for (let bit = 0; bit < 10; bit++) { reversed = (reversed << 1) | (index & 1); index >>>= 1; }
  return reversed ^ 8;
});
export function progressiveRay(index: number) { return rayOrder[index]; }

type Row = { entries: Uint32Array; firstRays: Uint16Array; start?: number; end?: number };
type Block = Row & { first: number; offsets: Uint32Array };

/** Compact partial rows, consumed in order and released as the next pass advances. */
export class ProgressiveRows {
  private blocks: (Block | undefined)[] = [];
  private cursor = 0;
  add(first: number, offsets: Uint32Array, entries: Uint32Array, firstRays: Uint16Array) {
    this.blocks.push({ first, offsets, entries, firstRays });
  }
  snapshot(indices: Uint32Array, pixels: number) {
    const offsets = new Uint32Array(pixels + 1);
    const entries = new Uint32Array(this.blocks.reduce((sum, block) => sum + (block?.entries.length ?? 0), 0));
    let cursor = 0, next = 0;
    for (const block of this.blocks) {
      if (!block) throw Error('Cannot snapshot consumed progressive rows.');
      for (let row = 0; row + 1 < block.offsets.length; row++) {
        const index = indices[block.first + row];
        offsets.fill(cursor + block.offsets[row], next, index + 1); next = index + 1;
      }
      entries.set(block.entries, cursor); cursor += block.entries.length;
    }
    offsets.fill(cursor, next);
    return { offsets, entries };
  }
  /** Consume the returned range before the next take; no per-row views are allocated. */
  take(index: number): Row | undefined {
    const block = this.blocks[this.cursor];
    if (!block) return;
    const row = index - block.first;
    if (row < 0 || row + 1 >= block.offsets.length) throw Error('Progressive rows must be consumed in order.');
    block.start = block.offsets[row]; block.end = block.offsets[row + 1];
    if (row + 2 === block.offsets.length) this.blocks[this.cursor++] = undefined;
    return block;
  }
}

/** Retain integer counts and earliest original ray so the final cache order is exact. */
export class ProgressiveHitPacker {
  private counts: Uint16Array;
  private first: Uint16Array;
  private targets = new Uint32Array(1024);
  private ordered = new Uint32Array(1024);
  private mask: number;
  private bits: number;
  representedHits = 0;
  constructor(pixels: number, bits: number) {
    this.bits = bits;
    this.counts = new Uint16Array(pixels); this.first = new Uint16Array(pixels); this.mask = 2 ** bits - 1;
  }
  pack(hits: Uint32Array, start: number, rayStart: number, rayEnd: number,
    output: Uint32Array, firstRays: Uint16Array, offset: number, previous?: Row) {
    let count = 0; this.representedHits = 0;
    if (previous) for (let i = previous.start ?? 0, end = previous.end ?? previous.entries.length; i < end; i++) {
      const entry = previous.entries[i], target = entry & this.mask, weight = entry >>> this.bits;
      this.targets[count++] = target; this.counts[target] = weight; this.first[target] = previous.firstRays[i];
      this.representedHits += weight;
    }
    for (let sample = rayStart; sample < rayEnd; sample++) {
      const target = hits[start + sample - rayStart];
      if (target === 0xffffffff || target === 0xfffffffe) continue;
      if (target >= this.counts.length) throw Error('Invalid diffuse transfer target.');
      const ray = progressiveRay(sample);
      if (this.counts[target] === 0) { this.targets[count++] = target; this.first[target] = ray; }
      else this.first[target] = Math.min(this.first[target], ray);
      this.counts[target]++; this.representedHits++;
    }
    for (let i = 0; i < count; i++) {
      const target = this.targets[i];
      const entry = packTransferEntry(target, this.counts[target], this.bits);
      if (rayEnd === 1024) this.ordered[this.first[target]] = entry;
      else { output[offset + i] = entry; firstRays[offset + i] = this.first[target]; }
      this.counts[target] = 0;
    }
    if (rayEnd === 1024) for (let ray = 0; ray < 1024; ray++) {
      const entry = this.ordered[ray];
      if (entry) { output[offset] = entry; firstRays[offset++] = ray; this.ordered[ray] = 0; }
    }
    return count;
  }
}
