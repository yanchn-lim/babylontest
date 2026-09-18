import { Constants, RawTexture, Vector3, type Mesh, type Scene, type WebGPUEngine } from '@babylonjs/core';
import { ToHalfFloat } from '@babylonjs/core/Misc/halfFloat';
import { CachedTransfer } from '../comparison/cached-transfer';
import type { SceneData } from '../comparison/main';
import type { lighting } from '../comparison/lighting';
import type { ApartmentLightmapState } from './lightmap';
import type { LightingPreviewChunk, LightingPreviewState } from '../comparison/streaming-preview';
import type { TransferCheckpoint } from '../comparison/transfer-checkpoint';
import { transferLayout } from '../comparison/transfer-layout';

export type LiveLightingSnapshot = Pick<LiveLightingResult, 'revision' | 'atlas' | 'sceneData'>;
export type LiveLightingStream = LiveLightingSnapshot & { lighting: LightingPreviewState; checkpoints?: boolean };

export interface LiveLightingResult {
  revision: number;
  atlas: number[][];
  sceneData: SceneData;
  transferBytes: ArrayBuffer;
}

/** A revision belongs to one immutable geometry snapshot in original mesh order. */
export class LiveLighting {
  readonly basis: ApartmentLightmapState;
  private black: RawTexture;
  private transfer?: CachedTransfer;
  private meshes: Mesh[] = [];
  private revision = -1;
  private disposed = false;
  private error = '';
  private uploadedBytes = 0;
  private published = false;
  private checkpoints = false;
  private finalRequested = false;
  private displayedRevision = 0;
  private stream?: RawTexture;
  private streamSequence = 0;
  private streamFraction = 0;
  private state?: ReturnType<typeof lighting>;
  private sky: [number, number, number] = [1, 1, 1];

  constructor(private scene: Scene, private engine: WebGPUEngine, private onReady: (revision: number) => void = () => {}) {
    this.black = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false);
    this.black.gammaSpace = false;
    this.basis = { texture: this.black, ready: false, sky: 0 };
  }

  reset(revision: number, meshes: Mesh[]) {
    if (this.disposed) throw Error('Live lighting is disposed.');
    if (!Number.isSafeInteger(revision) || revision <= this.revision) throw Error('Scene revisions must increase.');
    this.clear(); this.revision = revision; this.meshes = [...meshes];
  }

  private clear() {
    this.basis.ready = false; this.basis.texture = this.black;
    this.transfer?.dispose(); this.transfer = undefined;
    this.stream?.dispose(); this.stream = undefined;
    this.streamSequence = 0; this.streamFraction = 0;
    this.error = ''; this.uploadedBytes = 0; this.published = false;
    this.checkpoints = false; this.finalRequested = false; this.displayedRevision = 0;
  }

  setLighting(state: ReturnType<typeof lighting>, sky: [number, number, number]) {
    if (this.stream && (JSON.stringify(state) !== JSON.stringify(this.state) || JSON.stringify(sky) !== JSON.stringify(this.sky))) {
      this.basis.ready = false; this.basis.texture = this.black;
      this.stream.dispose(); this.stream = undefined; this.streamSequence = 0; this.streamFraction = 0;
    }
    this.state = structuredClone(state); this.sky = [...sky]; this.transfer?.setLighting(this.state, this.sky, 4);
  }

  private validate({ atlas, sceneData }: LiveLightingSnapshot) {
    if (!this.state) throw Error('Set current lighting before installing a result.');
    if (atlas.length !== this.meshes.length || sceneData.meshes.length !== this.meshes.length
      || atlas.some((uv, i) => uv.length !== this.meshes[i].getTotalVertices() * 2
        || uv.length !== sceneData.meshes[i].uvs.length
        || uv.some((value, j) => !Number.isFinite(value) || value !== sceneData.meshes[i].uvs[j]))) {
      throw Error('Lighting atlas does not match the scene snapshot.');
    }
    const point = new Vector3();
    this.meshes.forEach((mesh, i) => {
      const positions = mesh.getVerticesData('position')!, expected = sceneData.meshes[i].positions;
      if (positions.length !== expected.length) throw Error('Lighting geometry does not match the displayed model.');
      const world = mesh.computeWorldMatrix(true);
      for (let j = 0; j < positions.length; j += 3) {
        point.set(positions[j], positions[j + 1], positions[j + 2]);
        Vector3.TransformCoordinatesToRef(point, world, point);
        if ([point.x, point.y, point.z].some((value, axis) => !Number.isFinite(expected[j + axis])
          || Math.abs(value - expected[j + axis]) > 1e-5 * Math.max(1, Math.abs(value)))) {
          throw Error('Lighting geometry does not match the displayed model.');
        }
      }
    });
  }

  beginStream(snapshot: LiveLightingStream) {
    if (this.disposed || snapshot.revision !== this.revision) return false;
    if (snapshot.lighting.fixtureIntensityScale !== .35 || JSON.stringify(snapshot.lighting.state) !== JSON.stringify(this.state)
      || JSON.stringify(snapshot.sceneData.sky) !== JSON.stringify(this.sky)) { this.cancelStream(snapshot.revision); return false; }
    this.validate(snapshot);
    const layout = transferLayout(snapshot.sceneData);
    if (layout.height > this.engine.getCaps().maxTextureSize) throw Error('Lighting atlas exceeds this device texture limit.');
    this.clear();
    this.stream = RawTexture.CreateRGBATexture(new Uint16Array(layout.pixels * 4), 256, layout.height,
      this.scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
    this.stream.gammaSpace = false;
    this.stream.wrapU = this.stream.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    this.meshes.forEach((mesh, i) => mesh.setVerticesData('uv3', snapshot.atlas[i]));
    if (snapshot.checkpoints) {
      this.checkpoints = true;
      this.transfer = new CachedTransfer(this.scene, this.engine, snapshot.sceneData, null, .35, true, true, undefined,
        { uploadChunkBytes: 4 * 1024 * 1024, onUpload: bytes => { this.uploadedBytes = bytes; },
          independentUpdates: true, onUpdated: () => this.tick() });
      this.transfer.setLighting(this.state!, this.sky, 4);
    }
    return true;
  }

  async applyCheckpoint(checkpoint: TransferCheckpoint & { revision: number }) {
    if (this.disposed || checkpoint.revision !== this.revision || !this.checkpoints || this.finalRequested) return false;
    const transfer = this.transfer!;
    await transfer.updateCheckpoint(checkpoint);
    return !this.disposed && checkpoint.revision === this.revision && transfer === this.transfer;
  }

  updateStream(chunk: LightingPreviewChunk & { revision: number }) {
    if (this.disposed || chunk.revision !== this.revision || !this.stream || this.finalRequested || this.displayedRevision) return false;
    if (chunk.sequence <= this.streamSequence) return false;
    const rows = chunk.pixels.length / (256 * 4);
    if (chunk.sequence !== this.streamSequence + 1 || !Number.isInteger(chunk.firstRow) || chunk.firstRow < 0
      || !Number.isInteger(rows) || rows < 1 || rows > 64 || chunk.firstRow + rows > this.stream.getSize().height
      || !Number.isFinite(chunk.fraction) || chunk.fraction < this.streamFraction || chunk.fraction > 1
      || chunk.pixels.some(value => !Number.isFinite(value) || value < 0)) throw Error('Invalid streaming lighting update.');
    const pixels = Uint16Array.from(chunk.pixels, value => ToHalfFloat(Math.min(value, 65504)));
    this.engine.updateTextureData(this.stream.getInternalTexture()!, pixels, 0, chunk.firstRow, 256, rows);
    this.streamSequence = chunk.sequence; this.streamFraction = chunk.fraction;
    this.basis.texture = this.stream; this.basis.ready = true;
    return true;
  }

  cancelStream(revision: number) {
    if (revision === this.revision && !this.finalRequested) this.clear();
  }

  apply(result: LiveLightingResult) {
    if (this.disposed || result.revision !== this.revision) return false;
    this.validate(result);
    const { atlas, sceneData, transferBytes } = result;
    if (this.checkpoints && this.transfer) {
      if (this.finalRequested) return false;
      this.finalRequested = true;
      const transfer = this.transfer;
      void transfer.finish(transferBytes).catch(error => {
        if (this.transfer !== transfer) return;
        this.clear(); this.error = String(error);
      });
      return true;
    }
    if (!this.stream) this.clear();
    else { this.transfer?.dispose(); this.transfer = undefined; this.uploadedBytes = 0; this.published = false; }
    this.finalRequested = true;
    this.meshes.forEach((mesh, i) => mesh.setVerticesData('uv3', atlas[i]));
    this.transfer = new CachedTransfer(this.scene, this.engine, sceneData, transferBytes, .35, true, true, undefined,
      { uploadChunkBytes: 4 * 1024 * 1024, onUpload: bytes => { this.uploadedBytes = bytes; },
        independentUpdates: true, onUpdated: () => this.tick() });
    this.transfer.setLighting(this.state!, this.sky, 4);
    return true;
  }

  tick() {
    const transfer = this.transfer;
    if (!transfer) return;
    transfer.tick();
    if (transfer.error) {
      const error = transfer.error; this.clear(); this.error = error; return;
    }
    if (transfer.ready && !transfer.diagnostics().updating && transfer.revision !== this.displayedRevision) {
      this.displayedRevision = transfer.revision;
      this.basis.texture = transfer.texture; this.basis.ready = true;
      this.stream?.dispose(); this.stream = undefined;
      if (this.finalRequested && !this.published) { this.published = true; this.onReady(this.revision); }
    }
  }

  diagnostics() {
    return { revision: this.revision, phase: this.error ? 'error' : this.published ? 'ready' : this.checkpoints && !this.finalRequested ? 'refining' : this.transfer ? 'installing' : this.streamSequence ? 'streaming' : 'preview',
      streamUpdates: this.streamSequence, streamFraction: this.streamFraction,
      error: this.error, uploadedBytes: this.uploadedBytes, transfer: this.transfer?.diagnostics() };
  }

  dispose() { if (this.disposed) return; this.clear(); this.black.dispose(); this.disposed = true; }
}
