import { packTransferEntry } from './transfer-layout';

/** Extract visibility without allocating an array view for each atlas sample. */
export function transferVisibility(light: Float32Array) {
  const visibility = new Float32Array(light.length / 2);
  for (let source = 4, target = 0; source < light.length; source += 8, target += 4) {
    visibility[target] = light[source]; visibility[target + 1] = light[source + 1];
    visibility[target + 2] = light[source + 2]; visibility[target + 3] = light[source + 3];
  }
  return visibility;
}

/** Exact integer weights in first-hit order, with scratch storage reused for every sample. */
export class TransferHitPacker {
  private counts: Uint16Array;
  private targets = new Uint32Array(1024);
  private bits: number;
  backfaces = 0;
  representedHits = 0;

  constructor(pixels: number, bits: number) { this.counts = new Uint16Array(pixels); this.bits = bits; }

  pack(hits: Uint32Array, start: number, output: Uint32Array, offset: number) {
    let count = 0; this.backfaces = 0; this.representedHits = 0;
    for (let ray = 0; ray < 1024; ray++) {
      const target = hits[start + ray];
      if (target === 0xfffffffe) { this.backfaces++; continue; }
      if (target === 0xffffffff) continue;
      if (target >= this.counts.length) throw Error('Invalid diffuse transfer target.');
      if (this.counts[target] === 0) this.targets[count++] = target;
      this.counts[target]++; this.representedHits++;
    }
    for (let i = 0; i < count; i++) {
      const target = this.targets[i];
      output[offset + i] = packTransferEntry(target, this.counts[target], this.bits);
      this.counts[target] = 0;
    }
    return count;
  }
}
