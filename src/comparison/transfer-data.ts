import type { SceneData } from './main';
import source from './transfer-tracing.wgsl?raw';
import transferSource from './cached-transfer.wgsl?raw';
import fixedLightsSource from './transfer-lights.wgsl?raw';
import { repairShader } from './sample-repair';
import { transferLayout } from './transfer-layout';

export const TRANSFER_SIZE = 256;
export const TRANSFER_RAYS = 1024;
export const TRANSFER_PIXELS = TRANSFER_SIZE ** 2;
export const transferShader = source + '\n' + transferSource;
export const transferFields = ['sun', 'sunColor', 'sky', 'lamp0', 'lampColor0', 'lamp1', 'lampColor1',
  'origin', 'dimensions', 'range', 'nextDimensions', 'nextRange', 'update', 'bounce'];
export const transferBindings = ['nodes', 'triangles', 'surfaces', 'params', 'hits', 'surfaceLight',
  'cascades', 'output', 'bounceLight', 'transfer', 'offsets', 'fixedLights', 'rayOrigins', 'sampleRemap', 'activeIndices'];

// Keep the two-light comparison shader and its prepared cache unchanged.
export function transferSourceFor(data: SceneData, receivedDiffuse = false) {
  if (data.fixtures.length > 8) throw Error('Cached diffuse supports up to eight fixed lights.');
  // Change only the displayed sum; each propagated bounce keeps its surface colour.
  // Visibility preparation and cache fingerprints use the original source by default.
  let shader = receivedDiffuse ? source + '\n' + transferSource
    .replace('radiance*=surface.color.rgb/f32(SKY_RAYS);', 'radiance/=f32(SKY_RAYS);')
    .replace('vec4f(radiance,1)', 'vec4f(radiance*surface.color.rgb,1)')
    .replace('total+=surface.color.rgb*params.sky.rgb', 'total+=params.sky.rgb') : transferShader;
  if (data.fixtures.length !== 2) shader = shader
    .replace('fn prepareTransfer(', 'fn prepareTransferTwoLights(')
    .replace('fn shade(', 'fn shadeTwoLights(') + '\n' + fixedLightsSource;
  if (data.sampleRepair) shader = repairShader(shader);
  if (data.lightingLayout) shader = shader
    .replaceAll('packed&65535u', 'packed&2097151u').replaceAll('packed>>16u', 'packed>>21u')
    .replace('vec2f(params.sky.w-1.0)', 'vec2f(params.sky.w-1.0,params.dimensions.x-1.0)');
  return shader;
}

export function fixedLightData(data: SceneData, intensityScale = 1) {
  return new Float32Array(data.fixtures.flatMap(light => [...light.position, light.intensity * intensityScale, ...light.color, 0]));
}

export async function transferFingerprint(data: SceneData) {
  const layout = transferLayout(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(data) + transferSourceFor(data).replace(/\r\n/g, '\n') + `|atlas=${data.lightingLayout ? `${layout.width}x${layout.height}|layout=v2` : TRANSFER_SIZE}|rays=${TRANSFER_RAYS}|padding=closest-edge-v1${data.sampleRepair ? "|sample-repair-v1" : ""}`)));
}

export async function decodeTransfer(bytes: ArrayBuffer, data: SceneData) {
  const layout = transferLayout(data), n = layout.pixels;
  if (bytes.byteLength < 64 + (n + 1) * 4 + n * 16) throw Error('Incomplete diffuse transfer data.');
  const header = new Uint32Array(bytes, 0, 8);
  if (header[0] !== 0x31544644 || header[1] !== layout.version || header[2] !== layout.width || header[3] !== TRANSFER_RAYS
    || (layout.version === 2 && (header[5] !== layout.height || header[6] !== layout.bits))
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
      const count = entries[j] >>> layout.bits;
      if ((entries[j] & layout.mask) >= n) throw Error('Invalid diffuse transfer target.');
      if (!count || count > TRANSFER_RAYS) throw Error('Invalid diffuse transfer weight.');
      hits += count;
    }
    if (hits > TRANSFER_RAYS) throw Error('Diffuse transfer exceeds sample energy.');
  }
  if (!visibility.every((v, i) => Number.isFinite(v) && v >= 0 && v <=
    (i % 4 === 3 && data.fixtures.length !== 2 ? 255 : 1))) throw Error('Invalid cached visibility.');
  const remap = data.sampleRepair?.remap;
  if (data.sampleRepair && (!remap || remap.length !== n || remap.some(value => !Number.isInteger(value) || value < 0 || value >= n))) {
    throw Error('Invalid surface repair map. Regenerate the scene transfer.');
  }
  return { offsets, visibility, entries };
}
