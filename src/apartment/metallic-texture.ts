import { BaseTexture, type PBRMaterial } from '@babylonjs/core';
import type { SceneData } from '../comparison/main';

/** Metallic maps are linear data, even when the base colour uses sRGB. */
export async function metallicTextures(materials: PBRMaterial[]) {
  const textures = materials.map(material => (material.metallic ?? 0) > 0 ? material.metallicTexture : null);
  await new Promise<void>(resolve => BaseTexture.WhenAllReady(textures.filter((texture): texture is BaseTexture => !!texture), resolve));
  const cache = new Map<BaseTexture, Uint8Array>();
  const result: (SceneData['materials'][number]['metallicTexture'] | undefined)[] = [];
  for (const [index, texture] of textures.entries()) {
    if (!texture) { result.push(undefined); continue; }
    let source = cache.get(texture);
    if (!source) {
      const pixels = await texture.readPixels();
      if (!(pixels instanceof Uint8Array)) throw Error('Unsupported GI metallic texture: ' + texture.name);
      source = pixels; cache.set(texture, source);
    }
    const { width, height } = texture.getSize(), size = 128;
    const channel = materials[index].useMetallnessFromMetallicTextureBlue ? 2 : 0;
    const pixels: number[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * width / size), y0 = Math.floor(y * height / size);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / size));
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / size));
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += source[(sy * width + sx) * 4 + channel];
      pixels.push(Math.round(sum / ((x1 - x0) * (y1 - y0))));
    }
    result.push({ size, pixels, factor: materials[index].metallic!, wrapU: texture.wrapU, wrapV: texture.wrapV });
  }
  return result;
}
