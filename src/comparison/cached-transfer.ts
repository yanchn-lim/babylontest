import {
  ComputeShader, Constants, RawTexture, StorageBuffer, Texture, UniformBuffer,
  type Scene, type WebGPUEngine,
} from '@babylonjs/core';
import { transferLayout } from './transfer-layout';
import { pagedTransferSource, splitTransferPages, transferPageOffsets, TRANSFER_PAGE_BYTES, type TransferPage } from './transfer-pages';
import { geometry, geometryAsync } from './surface-geometry';
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
  readonly texture: RawTexture;
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

  constructor(scene: Scene, private engine: WebGPUEngine, data: SceneData, source: string | ArrayBuffer, private fixtureIntensityScale = 1, private blurDiffuse = false, private receivedDiffuse = false, private pageBytes = TRANSFER_PAGE_BYTES, private loadOptions: TransferLoadOptions = {}) {
    const chunk = loadOptions.uploadChunkBytes;
    if (chunk !== undefined && (!Number.isInteger(chunk) || chunk < 4 || chunk % 4)) throw Error('Upload chunk size must be a positive multiple of four.');
    this.layout = transferLayout(data);
    this.memoryBytes = this.layout.pixels * 8;
    if (this.layout.height > engine.getCaps().maxTextureSize) throw Error("Lighting atlas exceeds this device texture limit.");
    this.texture = new RawTexture(null, this.layout.width, this.layout.height, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    this.texture.gammaSpace = false;
    this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.params = new UniformBuffer(engine);
    transferFields.forEach(name => this.params.addUniform(name, 4)); this.params.create();
    this.params.updateFloat4('sky', 0, 0, 0, this.layout.width);
    this.params.updateFloat4('dimensions', this.layout.height, 0, 0, 0);
    data.fixtures.slice(0, 2).forEach((lamp, i) => {
      this.params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity * fixtureIntensityScale);
      this.params.updateFloat4('lampColor' + i, ...lamp.color, 0);
    });
    void this.load(data, source).catch(error => {
      if (!this.disposed) { this.error = String(error); this.loading = false; console.warn(this.error); }
    });
  }

  private async load(data: SceneData, input: string | ArrayBuffer) {
    let bytes: ArrayBuffer;
    if (typeof input === 'string') {
      const response = await fetch(input, { signal: this.request.signal });
      if (!response.ok || !response.body) throw Error('Could not load cached diffuse transfer.');
      const stream = response.headers.get('Content-Encoding')?.includes('gzip') ? response.body
        : response.body.pipeThrough(new DecompressionStream('gzip'));
      bytes = await new Response(stream).arrayBuffer();
    } else bytes = input;
    const yieldWork = async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      this.request.signal.throwIfAborted();
    };
    const paced = !!this.loadOptions.uploadChunkBytes;
    const cache = await decodeTransfer(bytes, data, paced ? yieldWork : undefined);
    if (this.disposed) return;
    const pages = splitTransferPages(cache.offsets, this.pageBytes);
    const mesh = paced ? await geometryAsync(data, this.blurDiffuse, yieldWork) : geometry(data, this.blurDiffuse);
    if (this.receivedDiffuse && this.blurDiffuse) {
      for (let i = 0; i < this.layout.pixels; i++) {
        if (paced && i % 2048 === 0) await yieldWork();
        if (mesh.surfaces[i * 12 + 3] === 0) continue;
        let front = 0;
        for (let j = cache.offsets[i]; j < cache.offsets[i + 1]; j++) front += cache.entries[j] >>> this.layout.bits;
        // Unrepresented, non-sky rays hit back faces. Reject only mostly invalid samples.
        const valid = front + cache.visibility[i * 4] * TRANSFER_RAYS >= TRANSFER_RAYS * .25;
        mesh.surfaces[i * 12 + 7] = Number(valid);
        this.rejectedSamples += Number(!valid);
      }
    }
    const allocations: Record<string, StorageBuffer> = {};
    let uploaded = 0;
    const buffer = async (name: string, value: ArrayBuffer | Float32Array | Uint32Array | number) => {
      this.request.signal.throwIfAborted();
      const size = typeof value === 'number' ? value : value.byteLength;
      const result = new StorageBuffer(this.engine, Math.max(4, size));
      this.buffers.push(result); allocations[name] = result; this.memoryBytes += Math.max(4, size);
      if (typeof value !== 'number') {
        const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const chunk = this.loadOptions.uploadChunkBytes ?? Math.max(4, size);
        for (let offset = 0; offset < size; offset += chunk) {
          const part = raw.subarray(offset, Math.min(size, offset + chunk));
          result.update(part, offset, part.byteLength); uploaded += part.byteLength;
          this.loadOptions.onUpload?.(uploaded);
          if (paced) await yieldWork();
        }
      }
      return result;
    };
    const surfaceLight = new Float32Array(this.layout.pixels * 8);
    for (let i = 0; i < this.layout.pixels; i++) surfaceLight.set(cache.visibility.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    if (mesh.rayOrigins) {
      await buffer('rayOrigins', mesh.rayOrigins); await buffer('sampleRemap', Uint32Array.from(data.sampleRepair!.remap!));
    }
    await buffer('nodes', mesh.nodes); await buffer('triangles', mesh.triangles); await buffer('surfaces', mesh.surfaces);
    await buffer('surfaceLight', surfaceLight); await buffer('bounceLight', this.layout.pixels * 32);
    for (const page of pages) this.transferPages.push({ ...page,
      transfer: await buffer('transfer', cache.entries.subarray(page.entryStart, page.entryEnd)),
      offsets: await buffer('offsets', transferPageOffsets(cache.offsets, page)),
    });
    if (data.fixtures.length !== 2) await buffer('fixedLights', fixedLightData(data, this.fixtureIntensityScale));
    this.request.signal.throwIfAborted();
    this.entryCount = cache.entries.length;
    const entries = {
      shade: [...(data.sampleRepair ? ['rayOrigins'] : []), 'nodes', 'triangles', 'surfaces', 'params', 'surfaceLight', ...(data.fixtures.length !== 2 ? ['fixedLights'] : [])],
      gatherTransfer: [...(data.sampleRepair ? ['sampleRemap'] : []), 'surfaces', 'params', 'surfaceLight', 'output', 'bounceLight', 'transfer', 'offsets'],
      advance: ['params', 'surfaceLight', 'bounceLight'],
      ...(this.blurDiffuse ? { blurDiffuse: ['surfaces', 'params', 'bounceLight', 'output'] } : {}),
      ...(!this.blurDiffuse && pages.length > 1 ? { publishTransfer: ['params', 'bounceLight', 'output'] } : {}),
    };
    let source = transferSourceFor(data, this.receivedDiffuse);
    if (pages.length > 1) source = pagedTransferSource(source, !!data.sampleRepair);
    if (this.blurDiffuse) source += '\n' + blurSource;
    for (const [entryPoint, names] of Object.entries(entries)) {
      const shader = new ComputeShader('Cached diffuse ' + entryPoint, this.engine, { computeSource: source }, {
        entryPoint, bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: transferBindings.indexOf(name) }])),
      });
      for (const name of names) {
        if (name === 'params') shader.setUniformBuffer(name, this.params);
        else if (name === 'output') shader.setStorageTexture(name, this.texture);
        else if (name === 'transfer' || name === 'offsets') shader.setStorageBuffer(name, this.transferPages[0][name]);
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
      atlasSize: this.layout.width, atlasHeight: this.layout.height, surfaceRays: TRANSFER_RAYS, entries: this.entryCount, memoryBytes: this.memoryBytes,
      lastDispatchGpuMilliseconds: Object.fromEntries(Object.entries(this.shaders).map(([name, shader]) =>
        [name, shader.gpuTimeInFrame ? shader.gpuTimeInFrame.counter.current / 1e6 : null])) };
  }

  dispose() {
    this.disposed = true; this.request.abort();
    this.buffers.forEach(buffer => buffer.dispose());
    this.params.dispose(); this.texture.dispose();
  }
}
