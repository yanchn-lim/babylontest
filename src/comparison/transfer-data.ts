import type { SceneData } from './main';
import source from './radiance-cascades.wgsl?raw';
import transferSource from './cached-transfer.wgsl?raw';
import fixedLightsSource from './transfer-lights.wgsl?raw';
import { adaptiveOffsets } from './adaptive-offsets';

export const TRANSFER_SIZE = 256;
export const TRANSFER_RAYS = 1024;
export const TRANSFER_PIXELS = TRANSFER_SIZE ** 2;
export const transferShader = source + '\n' + transferSource;
export const transferFields = ['sun', 'sunColor', 'sky', 'lamp0', 'lampColor0', 'lamp1', 'lampColor1',
  'origin', 'dimensions', 'range', 'nextDimensions', 'nextRange', 'update', 'bounce'];
export const transferBindings = ['nodes', 'triangles', 'surfaces', 'params', 'hits', 'surfaceLight',
  'cascades', 'output', 'bounceLight', 'transfer', 'offsets', 'fixedLights'];

// Keep the two-light comparison shader and its prepared cache unchanged.
export function transferSourceFor(data: SceneData) {
  if (data.fixtures.length > 8) throw Error('Cached diffuse supports up to eight fixed lights.');
  const shader = data.fixtures.length === 2 ? transferShader : transferShader
    .replace('fn prepareTransfer(', 'fn prepareTransferTwoLights(')
    .replace('fn shade(', 'fn shadeTwoLights(') + '\n' + fixedLightsSource;
  return data.adaptiveOffsets ? adaptiveOffsets(shader) : shader;
}

export function fixedLightData(data: SceneData) {
  return new Float32Array(data.fixtures.flatMap(light => [...light.position, light.intensity, ...light.color, 0]));
}

export async function transferFingerprint(data: SceneData) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(data) + transferSourceFor(data).replace(/\r\n/g, '\n') + `|atlas=${TRANSFER_SIZE}|rays=${TRANSFER_RAYS}|padding=closest-edge-v1`)));
}

export async function decodeTransfer(bytes: ArrayBuffer, data: SceneData) {
  const n = TRANSFER_PIXELS;
  if (bytes.byteLength < 64 + (n + 1) * 4 + n * 16) throw Error('Incomplete diffuse transfer data.');
  const header = new Uint32Array(bytes, 0, 8);
  if (header[0] !== 0x31544644 || header[1] !== 1 || header[2] !== TRANSFER_SIZE || header[3] !== TRANSFER_RAYS
    || bytes.byteLength !== 64 + (n + 1) * 4 + n * 16 + header[4] * 4) throw Error('Invalid diffuse transfer format.');
  const fingerprint = await transferFingerprint(data);
  if (!fingerprint.every((value, i) => value === new Uint8Array(bytes, 32, 32)[i])) {
    throw Error('Diffuse transfer is stale. Regenerate it for this scene and shader.');
  }
  const offsets = new Uint32Array(bytes, 64, n + 1);
  const visibility = new Float32Array(bytes, 64 + offsets.byteLength, n * 4);
  const entries = new Uint32Array(bytes, 64 + offsets.byteLength + visibility.byteLength, header[4]);
  if (offsets[0] !== 0 || offsets[n] !== entries.length) throw Error('Invalid diffuse transfer offsets.');
  for (let i = 0; i < n; i++) {
    if (offsets[i] > offsets[i + 1] || offsets[i + 1] > entries.length) throw Error('Invalid diffuse transfer row.');
    let hits = 0;
    for (let j = offsets[i]; j < offsets[i + 1]; j++) {
      const count = entries[j] >>> 16;
      if (!count || count > TRANSFER_RAYS) throw Error('Invalid diffuse transfer weight.');
      hits += count;
    }
    if (hits > TRANSFER_RAYS) throw Error('Diffuse transfer exceeds sample energy.');
  }
  if (!visibility.every((v, i) => Number.isFinite(v) && v >= 0 && v <=
    (i % 4 === 3 && data.fixtures.length !== 2 ? 255 : 1))) throw Error('Invalid cached visibility.');
  return { offsets, visibility, entries };
}
