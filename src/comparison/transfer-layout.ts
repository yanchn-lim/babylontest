import type { SceneData } from './main';

export interface LightingAllocation { id: string; x: number; y: number; size: number }
export interface LightingLayout {
  version: 1;
  width: 256;
  height: number;
  allocations: LightingAllocation[];
}

/** Version 1 caches retain their original 256-square layout and 16-bit addresses. */
export function transferLayout(data: Pick<SceneData, 'lightingLayout'>) {
  const layout = data.lightingLayout;
  if (layout && (layout.version !== 1 || layout.width !== 256 || !Number.isInteger(layout.height)
    || layout.height < 256 || layout.height > 8192 || layout.height % 64)) throw Error('Invalid lighting layout dimensions.');
  const width = 256, height = layout?.height ?? 256, bits = layout ? 21 : 16;
  return { width, height, pixels: width * height, bits, mask: 2 ** bits - 1, version: layout ? 2 : 1 };
}

export function packTransferEntry(target: number, weight: number, bits: number) {
  if ((bits !== 16 && bits !== 21) || !Number.isInteger(target) || target < 0 || target >= (bits === 16 ? 65536 : 2097152)
    || !Number.isInteger(weight) || weight < 1 || weight > 1024) throw Error('Invalid diffuse transfer entry.');
  return ((weight << bits) | target) >>> 0;
}
