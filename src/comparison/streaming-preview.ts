import { ComputeShader, type StorageBuffer, type UniformBuffer, type WebGPUEngine } from '@babylonjs/core';
import type { SceneData } from './main';
import type { lighting } from './lighting';
import { transferBindings, transferSourceFor } from './transfer-data';
import { transferLayout } from './transfer-layout';

export interface LightingPreviewChunk {
  sequence: number;
  firstRow: number;
  pixels: Float32Array;
  fraction: number;
}
export interface LightingPreviewState {
  state: ReturnType<typeof lighting>;
  fixtureIntensityScale: number;
}
export interface LightingPreviewOptions extends LightingPreviewState {
  onChunk: (chunk: LightingPreviewChunk) => Promise<void>;
}

/** Shadowed sun/lamp source radiance, independent of unfinished sky visibility. */
export async function previewSources(data: SceneData, engine: WebGPUEngine, params: UniformBuffer,
  buffers: Record<string, StorageBuffer>, options: LightingPreviewOptions, signal?: AbortSignal) {
  if (data.sampleRepair) throw Error('Streaming preview does not support sample-repair profiles.');
  const { state, fixtureIntensityScale } = options, n = transferLayout(data).pixels;
  params.updateFloat4('sun', ...state.direction as [number, number, number], state.sun);
  params.updateFloat4('sunColor', ...state.color as [number, number, number], Number(state.on));
  params.updateFloat4('bounce', fixtureIntensityScale, 0, 0, 0);
  let source = transferSourceFor(data);
  source += `
@compute @workgroup_size(64)
fn previewSources(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let index=id.x+u32(params.update.x);
  let surface=surfaces[index];
  if(surface.position.w==0.0){return;}
  let origin=surface.position.xyz+surface.normal.xyz*.004;
  var irradiance=vec3f(0);
  let cosine=max(0.0,dot(surface.normal.xyz,params.sun.xyz));
  if(params.sun.w>0.0&&cosine>0.0&&trace(origin,params.sun.xyz,24.0).facing==0.0) {
    irradiance+=params.sunColor.rgb*params.sun.w*cosine;
  }
  if(params.sunColor.w>.5) {
    ${data.fixtures.map((_, i) => `{
      let lamp=${data.fixtures.length === 2 ? 'params.lamp' + i : 'fixedLights[' + i * 2 + 'u]'};
      let color=${data.fixtures.length === 2 ? 'params.lampColor' + i : 'fixedLights[' + (i * 2 + 1) + 'u]'}.rgb;
      let delta=lamp.xyz-origin;
      let visible=f32(trace(origin,normalize(delta),length(delta)-.004).facing==0.0);
      irradiance+=lampIrradiance(surface,lamp,color,visible)*params.bounce.x;
    }`).join('\n')}
  }
  surfaceLight[index].radiance=vec4f(surface.color.rgb*irradiance/PI,1);
}`;
  const names = ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', ...(data.fixtures.length === 2 ? [] : ['fixedLights'])];
  const shader = new ComputeShader('Streaming source lighting', engine, { computeSource: source }, {
    entryPoint: 'previewSources', bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
  });
  for (const name of names) {
    if (name === 'params') shader.setUniformBuffer(name, params); else shader.setStorageBuffer(name, buffers[name]);
  }
  let failure = '';
  shader.onError = (_effect, error) => { failure = error; };
  for (let first = 0; first < n; first += 4096) {
    signal?.throwIfAborted();
    params.updateFloat4('update', first, Math.min(4096, n - first), 0, 0); params.update();
    while (!shader.dispatch(Math.ceil(Math.min(4096, n - first) / 64))) {
      if (failure) throw Error(failure);
      signal?.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await buffers.surfaceLight.read(0, 4, undefined, true);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  const raw = await buffers.surfaceLight.read(0, undefined, undefined, true);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

/** Only finished rows contribute. No guessed visibility or lighting from an older scene. */
export class StreamingPreview {
  private pixels: Float32Array;
  private first = Infinity;
  private last = -1;
  private sequence = 0;
  private emitted = 0;
  private bits: number;
  private mask: number;
  private sky: number[];
  private sources: Float32Array;
  private frontHits: Uint16Array;

  constructor(data: SceneData, sources: Float32Array, skyScale: number) {
    const layout = transferLayout(data);
    this.pixels = new Float32Array(layout.pixels * 4);
    this.frontHits = new Uint16Array(layout.pixels);
    this.bits = layout.bits; this.mask = layout.mask; this.sources = sources;
    this.sky = data.sky.map(v => v * skyScale);
  }

  add(index: number, packed: Uint32Array, start: number, count: number, frontHits: number) {
    this.first = Math.min(this.first, index); this.last = Math.max(this.last, index);
    this.frontHits[index] = frontHits;
    const offset = index * 4;
    for (let j = start; j < start + count; j++) {
      const target = (packed[j] & this.mask) * 8, weight = (packed[j] >>> this.bits) / 1024;
      for (let c = 0; c < 3; c++) this.pixels[offset + c] += this.sources[target + c] * weight;
    }
    this.pixels[offset + 3] = 1;
  }

  async flush(surfaceLight: StorageBuffer, fraction: number, emit: LightingPreviewOptions['onChunk'], signal?: AbortSignal) {
    if (this.last < 0 || (fraction < 1 && performance.now() - this.emitted < 400)) return;
    const first = Math.floor(this.first / 256), last = Math.floor(this.last / 256) + 1;
    for (let row = first; row < last; row += 64) {
      signal?.throwIfAborted();
      const end = Math.min(last, row + 64);
      const raw = await surfaceLight.read(row * 256 * 32, (end - row) * 256 * 32, undefined, true);
      const visibility = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const pixels = this.pixels.slice(row * 256 * 4, end * 256 * 4);
      for (let i = 0; i < pixels.length / 4; i++) {
        if (!pixels[i * 4 + 3]) continue;
        const open = visibility[i * 8 + 4];
        // Match the final renderer's rejection of mostly back-facing samples.
        if (this.frontHits[row * 256 + i] + open * 1024 < 1024 * .25) { pixels.fill(0, i * 4, i * 4 + 4); continue; }
        for (let c = 0; c < 3; c++) pixels[i * 4 + c] += this.sky[c] * open;
      }
      await emit({ sequence: ++this.sequence, firstRow: row, pixels, fraction });
    }
    this.first = Infinity; this.last = -1; this.emitted = performance.now();
  }
}
