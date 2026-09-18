import { workBudget } from './work-budget';
import {
  ComputeShader, Constants, RawTexture, StorageBuffer, Texture, UniformBuffer,
  type Scene, type WebGPUEngine,
} from '@babylonjs/core';
import { transferLayout } from './transfer-layout';
import { pagedTransferSource, splitTransferPages, transferPageOffsets, TRANSFER_PAGE_BYTES, type TransferPage } from './transfer-pages';
import { geometry, geometryAsync } from './surface-geometry';
import { validateCheckpoint, type TransferCheckpoint } from './transfer-checkpoint';
import blurSource from './diffuse-blur.wgsl?raw';
import type { SceneData } from './main';
import type { lighting } from './lighting';
import { decodeTransfer, fixedLightData, transferBindings, transferFields, transferSourceFor,
  TRANSFER_RAYS } from './transfer-data';

type Vec3 = [number, number, number];
export interface TransferLoadOptions {
  /** Opt-in paced uploads for a live editor. Existing file viewers retain their path. */
  uploadChunkBytes?: number;
  onUpload?: (bytes: number) => void;
}

/** Dense diffuse sampling, with static ray hits combined into exact integer weights. */
export class CachedTransfer {
  private displayTexture: RawTexture;
  private targetTexture: RawTexture;
  get texture() { return this.displayTexture; }
  private checkpointMode: boolean;
  private prepared?: Promise<void>;
  private mesh?: ReturnType<typeof geometry>;
  private allocations: Record<string, StorageBuffer> = {};
  private uploaded = 0;
  private rays = 0;
  private operation = false;
  private currentLighting?: { state: ReturnType<typeof lighting>; sky: Vec3; bounces: number };
  private checkpointWait?: { resolve: () => void; reject: (reason: unknown) => void };
  memoryBytes: number;
  private layout: ReturnType<typeof transferLayout>;
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
  private rejectedSamples = 0;
  private transferPages: (TransferPage & { transfer: StorageBuffer; offsets: StorageBuffer })[] = [];
  private gatherPage = 0;

  constructor(scene: Scene, private engine: WebGPUEngine, private data: SceneData, source: string | ArrayBuffer | null, private fixtureIntensityScale = 1, private blurDiffuse = false, private receivedDiffuse = false, private pageBytes = TRANSFER_PAGE_BYTES, private loadOptions: TransferLoadOptions = {}) {
    const chunk = loadOptions.uploadChunkBytes;
    if (chunk !== undefined && (!Number.isInteger(chunk) || chunk < 4 || chunk % 4)) throw Error('Upload chunk size must be a positive multiple of four.');
    this.layout = transferLayout(data);
    this.memoryBytes = this.layout.pixels * 8;
    if (this.layout.height > engine.getCaps().maxTextureSize) throw Error("Lighting atlas exceeds this device texture limit.");
    this.checkpointMode = source === null;
    this.displayTexture = new RawTexture(null, this.layout.width, this.layout.height, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    this.texture.gammaSpace = false;
    this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.targetTexture = this.checkpointMode ? new RawTexture(null, this.layout.width, this.layout.height, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE) : this.displayTexture;
    this.targetTexture.gammaSpace = false;
    this.targetTexture.wrapU = this.targetTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    if (this.checkpointMode) this.memoryBytes += this.layout.pixels * 8;
    this.params = new UniformBuffer(engine);
    transferFields.forEach(name => this.params.addUniform(name, 4)); this.params.create();
    this.params.updateFloat4('sky', 0, 0, 0, this.layout.width);
    this.params.updateFloat4('dimensions', this.layout.height, 0, 0, 0);
    data.fixtures.slice(0, 2).forEach((lamp, i) => {
      this.params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity * fixtureIntensityScale);
      this.params.updateFloat4('lampColor' + i, ...lamp.color, 0);
    });
    if (source === null) {
      this.prepared = this.initialize();
      void this.prepared.catch(error => this.fail(error));
    } else void this.load(source).catch(error => this.fail(error));
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    this.error = String(error); this.loading = false;
    this.checkpointWait?.reject(error); this.checkpointWait = undefined;
    console.warn(this.error);
  }

  private async yieldWork() {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.request.signal.throwIfAborted();
  }

  private async upload(buffer: StorageBuffer, value: ArrayBuffer | Float32Array | Uint32Array) {
    const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const chunk = this.loadOptions.uploadChunkBytes ?? Math.max(4, raw.byteLength);
    for (let offset = 0; offset < raw.byteLength; offset += chunk) {
      this.request.signal.throwIfAborted();
      const part = raw.subarray(offset, Math.min(raw.byteLength, offset + chunk));
      buffer.update(part, offset, part.byteLength); this.uploaded += part.byteLength;
      this.loadOptions.onUpload?.(this.uploaded);
      if (this.loadOptions.uploadChunkBytes) await this.yieldWork();
    }
  }

  private async buffer(name: string, value: ArrayBuffer | Float32Array | Uint32Array | number, permanent = true) {
    this.request.signal.throwIfAborted();
    const size = Math.max(4, typeof value === 'number' ? value : value.byteLength);
    const buffer = new StorageBuffer(this.engine, size); this.memoryBytes += size;
    // Track before upload so cancellation also disposes an incomplete allocation.
    this.buffers.push(buffer);
    if (permanent) this.allocations[name] = buffer;
    if (typeof value !== 'number') await this.upload(buffer, value);
    return buffer;
  }

  private async initialize() {
    const data = this.data;
    const mesh = this.loadOptions.uploadChunkBytes ? await geometryAsync(data, this.blurDiffuse, () => this.yieldWork()) : geometry(data, this.blurDiffuse);
    this.mesh = mesh;
    if (mesh.rayOrigins) {
      await this.buffer('rayOrigins', mesh.rayOrigins); await this.buffer('sampleRemap', Uint32Array.from(data.sampleRepair!.remap!));
    }
    await this.buffer('nodes', mesh.nodes); await this.buffer('triangles', mesh.triangles);
    await this.buffer('surfaces', mesh.surfaces);
    await this.buffer('surfaceLight', this.layout.pixels * 32); await this.buffer('bounceLight', this.layout.pixels * 32);
    if (data.fixtures.length !== 2) await this.buffer('fixedLights', fixedLightData(data, this.fixtureIntensityScale));
    if (this.checkpointMode) {
      await this.buffer('transfer', 4); await this.buffer('offsets', 4);
      this.createShaders();
    }
  }

  private async install(cache: { offsets: Uint32Array; entries: Uint32Array; visibility: Float32Array; frontHits?: Uint16Array }, rays: number) {
    await (this.prepared ??= this.initialize());
    this.request.signal.throwIfAborted();
    const mesh = this.mesh!, validity = this.receivedDiffuse && this.blurDiffuse;
    const pause = workBudget(this.loadOptions.uploadChunkBytes ? () => this.yieldWork() : undefined);
    const surfaceLight = new Float32Array(this.layout.pixels * 8);
    this.rejectedSamples = 0;
    for (let i = 0; i < this.layout.pixels; i++) {
      if (i % 128 === 0) { const pending = pause(); if (pending) await pending; }
      if (validity && mesh.surfaces[i * 12 + 3] !== 0) {
        const valid = cache.frontHits![i] + cache.visibility[i * 4] * rays >= rays * .25;
        mesh.surfaces[i * 12 + 7] = Number(valid); this.rejectedSamples += Number(!valid);
      }
      for (let c = 0; c < 4; c++) surfaceLight[i * 8 + 4 + c] = cache.visibility[i * 4 + c];
    }
    if (validity) await this.upload(this.allocations.surfaces, mesh.surfaces);
    await this.upload(this.allocations.surfaceLight, surfaceLight);
    for (const page of this.transferPages) for (const buffer of [page.transfer, page.offsets]) {
      this.memoryBytes -= buffer.getBuffer().capacity;
      this.buffers.splice(this.buffers.indexOf(buffer), 1); buffer.dispose();
    }
    this.transferPages = [];
    for (const page of splitTransferPages(cache.offsets, this.pageBytes)) this.transferPages.push({ ...page,
      transfer: await this.buffer('transfer', cache.entries.subarray(page.entryStart, page.entryEnd), false),
      offsets: await this.buffer('offsets', transferPageOffsets(cache.offsets, page), false),
    });
    this.request.signal.throwIfAborted();
    this.entryCount = cache.entries.length; this.rays = rays;
    this.params.updateFloat4('nextDimensions', rays, 0, 0, 0);
    if (!Object.keys(this.shaders).length) this.createShaders();
    this.stage = 0; this.bounce = 0; this.gatherPage = 0; this.pending = this.currentLighting; this.dirty = true;
  }

  private async load(input: string | ArrayBuffer) {
    let bytes: ArrayBuffer;
    if (typeof input === 'string') {
      const response = await fetch(input, { signal: this.request.signal });
      if (!response.ok || !response.body) throw Error('Could not load cached diffuse transfer.');
      const stream = response.headers.get('Content-Encoding')?.includes('gzip') ? response.body
        : response.body.pipeThrough(new DecompressionStream('gzip'));
      bytes = await new Response(stream).arrayBuffer();
    } else bytes = input;
    const cache = await decodeTransfer(bytes, this.data, this.loadOptions.uploadChunkBytes ? () => this.yieldWork() : undefined, this.receivedDiffuse && this.blurDiffuse);
    await this.install(cache, TRANSFER_RAYS);
    this.loading = false;
  }

  async updateCheckpoint(checkpoint: TransferCheckpoint) {
    if (!this.checkpointMode || this.operation || checkpoint.rays <= this.rays) throw Error('Invalid checkpoint sequence.');
    this.operation = true; this.loading = true; this.dirty = true;
    try {
      const cache = await validateCheckpoint(checkpoint, this.data, () => this.yieldWork(), this.receivedDiffuse && this.blurDiffuse);
      await this.install(cache, checkpoint.rays);
      await new Promise<void>((resolve, reject) => { this.checkpointWait = { resolve, reject }; this.loading = false; });
    } catch (error) { this.fail(error); throw error; }
    finally { this.operation = false; }
  }

  async finish(bytes: ArrayBuffer) {
    if (!this.checkpointMode || this.operation || this.rays === 1024) throw Error('Lighting checkpoint is busy or already final.');
    this.operation = true; this.loading = true; this.dirty = true;
    try { await this.load(bytes); }
    catch (error) { this.fail(error); throw error; }
    finally { this.operation = false; }
  }

  private createShaders() {
    const data = this.data;
    const entries = {
      shade: [...(data.sampleRepair ? ['rayOrigins'] : []), 'nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', ...(data.fixtures.length !== 2 ? ['fixedLights'] : [])],
      gatherTransfer: [...(data.sampleRepair ? ['sampleRemap'] : []), 'surfaces', 'params', 'surfaceLight', 'output', 'bounceLight', 'transfer', 'offsets'],
      advance: ['params', 'surfaceLight', 'bounceLight'],
      ...(this.blurDiffuse ? { blurDiffuse: ['surfaces', 'params', 'bounceLight', 'output'] } : {}),
      ...(!this.blurDiffuse && (this.checkpointMode || this.transferPages.length > 1) ? { publishTransfer: ['params', 'bounceLight', 'output'] } : {}),
    };
    let source = transferSourceFor(data, this.receivedDiffuse);
    if (this.checkpointMode || this.transferPages.length > 1) source = pagedTransferSource(source, !!data.sampleRepair);
    if (this.checkpointMode) source = source.replaceAll('f32(SKY_RAYS)', 'params.nextDimensions.x');
    if (this.blurDiffuse) source += '\n' + blurSource;
    for (const [entryPoint, names] of Object.entries(entries)) {
      const shader = new ComputeShader('Cached diffuse ' + entryPoint, this.engine, { computeSource: source }, {
        entryPoint, bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
      });
      for (const name of names) {
        if (name === 'params') shader.setUniformBuffer(name, this.params);
        else if (name === 'output') shader.setStorageTexture(name, this.targetTexture);
        else if (name === 'transfer' || name === 'offsets') shader.setStorageBuffer(name, (this.transferPages[0]?.[name] ?? this.allocations[name]));
        else shader.setStorageBuffer(name, this.allocations[name]);
      }
      shader.onError = (_effect, error) => this.fail(error);
      this.shaders[entryPoint] = shader;
      if (this.checkpointMode) shader.isReady();
    }
  }

  setLighting(state: ReturnType<typeof lighting>, sky: Vec3, bounces = 4) {
    this.currentLighting = this.pending = { state, sky, bounces: Math.max(1, Math.min(4, Math.round(bounces))) };
    this.dirty = true;
  }

  tick() {
    if (this.loading || this.error || !this.dirty || this.disposed) return;
    if (this.stage === 0 && this.bounce === 0 && this.pending) {
      const { state, sky, bounces } = this.pending;
      this.params.updateFloat4('sun', ...state.direction as Vec3, state.sun);
      this.params.updateFloat4('sunColor', ...state.color as Vec3, Number(state.on));
      this.params.updateFloat4('sky', ...sky.map(v => v * state.sky) as Vec3, this.layout.width);
      this.activeBounces = bounces; this.started = performance.now(); this.pending = undefined;
    }
    this.params.updateFloat4('update', 0, this.layout.pixels, 0, Number(this.receivedDiffuse && this.blurDiffuse));
    const finalPass = this.blurDiffuse || this.transferPages.length > 1;
    this.params.updateFloat4('bounce', this.bounce, Number(this.bounce + 1 === this.activeBounces && !finalPass), 0, 0);
    const filtering = this.bounce === this.activeBounces;
    const name = filtering ? (this.blurDiffuse ? 'blurDiffuse' : 'publishTransfer') : this.stage === 0 ? (this.bounce === 0 ? 'shade' : 'advance') : 'gatherTransfer';
    if (name === 'gatherTransfer') {
      const page = this.transferPages[this.gatherPage];
      this.params.updateFloat4('range', page.firstRow, page.lastRow, 0, 0);
      this.shaders[name].setStorageBuffer('transfer', page.transfer);
      this.shaders[name].setStorageBuffer('offsets', page.offsets);
    }
    this.params.update();
    if (!this.shaders[name].dispatch(Math.ceil(this.layout.pixels / 64))) return;
    if (name === 'gatherTransfer') {
      if (++this.gatherPage < this.transferPages.length) return;
      this.gatherPage = 0;
    }
    if (!filtering) {
      if (++this.stage < 2) return;
      this.stage = 0;
      if (++this.bounce < this.activeBounces || finalPass) return;
    }
    this.bounce = 0; this.completedBounces = this.activeBounces;
    this.lastUpdateWallMilliseconds = performance.now() - this.started;
    this.ready = true; this.dirty = !!this.pending; this.revision++;
    if (this.checkpointMode && !this.dirty) {
      [this.displayTexture, this.targetTexture] = [this.targetTexture, this.displayTexture];
      for (const name of ['gatherTransfer', 'blurDiffuse', 'publishTransfer']) this.shaders[name]?.setStorageTexture('output', this.targetTexture);
      this.checkpointWait?.resolve(); this.checkpointWait = undefined;
    }
  }

  get status() {
    if (this.error) return 'Cached diffuse unavailable · baked fallback';
    if (this.loading) return 'Loading cached diffuse transfer';
    return this.dirty ? 'Updating cached diffuse lighting' : `Cached diffuse · ${this.completedBounces} bounces · 1,024 rays`;
  }

  diagnostics() {
    return { ready: this.ready, updating: this.dirty, loading: this.loading, revision: this.revision, error: this.error,
      requestedBounces: this.pending?.bounces ?? this.activeBounces, completedBounces: this.completedBounces,
      lastUpdateDispatches: this.completedBounces ? this.completedBounces * (1 + this.transferPages.length) + Number(this.blurDiffuse || this.transferPages.length > 1) : 0,
      transferPages: this.transferPages.length, transferBytes: this.entryCount * 4,
      largestTransferPageBytes: Math.max(0, ...this.transferPages.map(page => (page.entryEnd - page.entryStart) * 4)),
      blurDiffuse: this.blurDiffuse, receivedDiffuse: this.receivedDiffuse, rejectedSamples: this.rejectedSamples, lastUpdateWallMilliseconds: this.lastUpdateWallMilliseconds,
      checkpointRays: this.rays, preparedGeometry: !!this.mesh,
      atlasSize: this.layout.width, atlasHeight: this.layout.height, surfaceRays: TRANSFER_RAYS, entries: this.entryCount, memoryBytes: this.memoryBytes,
      lastDispatchGpuMilliseconds: Object.fromEntries(Object.entries(this.shaders).map(([name, shader]) =>
        [name, shader.gpuTimeInFrame ? shader.gpuTimeInFrame.counter.current / 1e6 : null])) };
  }

  dispose() {
    this.disposed = true; this.request.abort();
    this.checkpointWait?.reject(this.request.signal.reason); this.checkpointWait = undefined;
    this.buffers.forEach(buffer => buffer.dispose());
    this.params.dispose(); this.displayTexture.dispose();
    if (this.targetTexture !== this.displayTexture) this.targetTexture.dispose();
  }
}
