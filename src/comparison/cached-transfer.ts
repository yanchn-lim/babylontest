import {
  ComputeShader, Constants, RawTexture, StorageBuffer, Texture, UniformBuffer,
  type Scene, type WebGPUEngine,
} from '@babylonjs/core';
import { geometry } from './radiance-cascades';
import type { SceneData } from './main';
import type { lighting } from './lighting';
import { decodeTransfer, transferBindings, transferFields, transferShader,
  TRANSFER_SIZE, TRANSFER_PIXELS, TRANSFER_RAYS } from './transfer-data';

type Vec3 = [number, number, number];

/** Dense diffuse sampling, with static ray hits combined into exact integer weights. */
export class CachedTransfer {
  readonly texture: RawTexture;
  memoryBytes = TRANSFER_PIXELS * 8;
  error = '';
  ready = false;
  revision = 0;
  private loading = true;
  private disposed = false;
  private request = new AbortController();
  private buffers: StorageBuffer[] = [];
  private params: UniformBuffer;
  private shaders: Record<string, ComputeShader> = {};
  private pending?: { state: ReturnType<typeof lighting>; sky: Vec3; bounces: number };
  private stage = 0;
  private bounce = 0;
  private activeBounces = 1;
  private completedBounces = 0;
  private dirty = true;
  private started = 0;
  private lastUpdateWallMilliseconds = 0;
  private entryCount = 0;

  constructor(scene: Scene, private engine: WebGPUEngine, data: SceneData, url: string) {
    this.texture = new RawTexture(null, TRANSFER_SIZE, TRANSFER_SIZE, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    this.texture.gammaSpace = false;
    this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.params = new UniformBuffer(engine);
    transferFields.forEach(name => this.params.addUniform(name, 4)); this.params.create();
    this.params.updateFloat4('sky', 0, 0, 0, TRANSFER_SIZE);
    data.fixtures.forEach((lamp, i) => {
      this.params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity);
      this.params.updateFloat4('lampColor' + i, ...lamp.color, 0);
    });
    void this.load(data, url).catch(error => {
      if (!this.disposed) { this.error = String(error); this.loading = false; console.warn(this.error); }
    });
  }

  private async load(data: SceneData, url: string) {
    const response = await fetch(url, { signal: this.request.signal });
    if (!response.ok || !response.body) throw Error('Could not load cached diffuse transfer.');
    const stream = response.headers.get('Content-Encoding')?.includes('gzip') ? response.body
      : response.body.pipeThrough(new DecompressionStream('gzip'));
    const bytes = await new Response(stream).arrayBuffer();
    const cache = await decodeTransfer(bytes, data);
    if (this.disposed) return;
    // Keep each binding below the portable WebGPU storage-buffer limit.
    if (cache.entries.byteLength > 128 * 1024 * 1024) throw Error('Diffuse transfer exceeds the prototype buffer budget.');
    const mesh = geometry(data);
    const allocations: Record<string, StorageBuffer> = {};
    const buffer = (name: string, value: ArrayBuffer | Float32Array | Uint32Array | number) => {
      const size = typeof value === 'number' ? value : value.byteLength;
      const result = new StorageBuffer(this.engine, Math.max(4, size));
      if (typeof value !== 'number') result.update(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      this.buffers.push(result); allocations[name] = result; this.memoryBytes += Math.max(4, size);
    };
    const surfaceLight = new Float32Array(TRANSFER_PIXELS * 8);
    for (let i = 0; i < TRANSFER_PIXELS; i++) surfaceLight.set(cache.visibility.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    buffer('nodes', mesh.nodes); buffer('triangles', mesh.triangles); buffer('surfaces', mesh.surfaces);
    buffer('surfaceLight', surfaceLight); buffer('bounceLight', TRANSFER_PIXELS * 32);
    buffer('transfer', cache.entries); buffer('offsets', cache.offsets);
    this.entryCount = cache.entries.length;
    const entries = {
      shade: ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight'],
      gatherTransfer: ['surfaces', 'params', 'surfaceLight', 'output', 'bounceLight', 'transfer', 'offsets'],
      advance: ['params', 'surfaceLight', 'bounceLight'],
    };
    for (const [entryPoint, names] of Object.entries(entries)) {
      const shader = new ComputeShader('Cached diffuse ' + entryPoint, this.engine, { computeSource: transferShader }, {
        entryPoint, bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
      });
      for (const name of names) {
        if (name === 'params') shader.setUniformBuffer(name, this.params);
        else if (name === 'output') shader.setStorageTexture(name, this.texture);
        else shader.setStorageBuffer(name, allocations[name]);
      }
      shader.onError = (_effect, error) => { this.error = error; this.ready = false; };
      this.shaders[entryPoint] = shader;
    }
    this.loading = false;
  }

  setLighting(state: ReturnType<typeof lighting>, sky: Vec3, bounces = 4) {
    this.pending = { state, sky, bounces: Math.max(1, Math.min(4, Math.round(bounces))) };
    this.dirty = true;
  }

  tick() {
    if (this.loading || this.error || !this.dirty || this.disposed) return;
    if (this.stage === 0 && this.bounce === 0 && this.pending) {
      const { state, sky, bounces } = this.pending;
      this.params.updateFloat4('sun', ...state.direction as Vec3, state.sun);
      this.params.updateFloat4('sunColor', ...state.color as Vec3, Number(state.on));
      this.params.updateFloat4('sky', ...sky.map(v => v * state.sky) as Vec3, TRANSFER_SIZE);
      this.activeBounces = bounces; this.started = performance.now(); this.pending = undefined;
    }
    this.params.updateFloat4('update', 0, TRANSFER_PIXELS, 0, 0);
    this.params.updateFloat4('bounce', this.bounce, Number(this.bounce + 1 === this.activeBounces), 0, 0);
    this.params.update();
    const name = this.stage === 0 ? (this.bounce === 0 ? 'shade' : 'advance') : 'gatherTransfer';
    if (!this.shaders[name].dispatch(Math.ceil(TRANSFER_PIXELS / 64))) return;
    if (++this.stage < 2) return;
    this.stage = 0;
    if (++this.bounce < this.activeBounces) return;
    this.bounce = 0; this.completedBounces = this.activeBounces;
    this.lastUpdateWallMilliseconds = performance.now() - this.started;
    this.ready = true; this.dirty = !!this.pending; this.revision++;
  }

  get status() {
    if (this.error) return 'Cached diffuse unavailable · baked fallback';
    if (this.loading) return 'Loading cached diffuse transfer';
    return this.dirty ? 'Updating cached diffuse lighting' : `Cached diffuse · ${this.completedBounces} bounces · 1,024 rays`;
  }

  diagnostics() {
    return { ready: this.ready, updating: this.dirty, loading: this.loading, revision: this.revision, error: this.error,
      requestedBounces: this.pending?.bounces ?? this.activeBounces, completedBounces: this.completedBounces,
      lastUpdateDispatches: this.completedBounces * 2, lastUpdateWallMilliseconds: this.lastUpdateWallMilliseconds,
      atlasSize: TRANSFER_SIZE, surfaceRays: TRANSFER_RAYS, entries: this.entryCount, memoryBytes: this.memoryBytes,
      lastDispatchGpuMilliseconds: Object.fromEntries(Object.entries(this.shaders).map(([name, shader]) =>
        [name, shader.gpuTimeInFrame ? shader.gpuTimeInFrame.counter.current / 1e6 : null])) };
  }

  dispose() {
    this.disposed = true; this.request.abort();
    this.buffers.forEach(buffer => buffer.dispose());
    this.params.dispose(); this.texture.dispose();
  }
}
