import {
  ComputeShader, Constants, RawTexture, StorageBuffer, Texture, UniformBuffer,
  type Scene, type WebGPUEngine,
} from '@babylonjs/core';
import { buildBvh, packBvh, type Triangle } from '../interior-lighting/bvh';
import type { SceneData } from './main';
import type { lighting } from './lighting';
import source from './radiance-cascades.wgsl?raw';

type Vec3 = [number, number, number];
const SIZE = 256;
const RAYS = 64;
const NEAR = .75;
interface Level { dimensions: Vec3; spacing: number; start: number; end: number; directions: number; offset: number; count: number }

// The exported UVs are shared by the reference, baked baseline and cascade output.
export function geometry(data: SceneData) {
  const surfaces = new Float32Array(SIZE * SIZE * 12);
  const distances = new Float32Array(SIZE * SIZE).fill(Infinity);
  const triangles: Triangle[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const mesh of data.meshes) {
    const material = data.materials[mesh.material];
    if (material.transmitting) continue;
    const position = (i: number) => mesh.positions.slice(i * 3, i * 3 + 3) as Vec3;
    for (let face = 0; face < mesh.indices.length; face += 3) {
      const ids = mesh.indices.slice(face, face + 3);
      const points = ids.map(position);
      const insetWeights = points.map((p, j) => {
        if (!data.surfaceInset) return 0;
        const a = points[(j + 1) % 3].map((v, k) => v - p[k]);
        const b = points[(j + 2) % 3].map((v, k) => v - p[k]);
        const twiceArea = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
        const height = twiceArea / Math.hypot(...a.map((v, k) => v - b[k]));
        return Math.min(data.adaptiveOffsets ? .05 : 1 / 3, data.surfaceInset / height);
      });
      const uv = ids.map(i => mesh.uvs.slice(i * 2, i * 2 + 2));
      triangles.push({ a: points[0], b: points[1], c: points[2], material: mesh.material,
        uv: uv.flat() as Triangle['uv'] });
      for (const p of points) for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]);
      }
      const [a, b, c] = uv.map(v => v.map(n => n * SIZE));
      const area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(area) < 1e-8) continue;
      const lo = [0, 1].map(k => Math.max(0, Math.floor(Math.min(a[k], b[k], c[k]) - 2)));
      const hi = [0, 1].map(k => Math.min(SIZE - 1, Math.ceil(Math.max(a[k], b[k], c[k]) + 2)));
      for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const u = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / area;
        const v = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / area;
        const weights = [u, v, 1 - u - v];
        let positionWeights = weights;
        let distance = 0;
        if (Math.min(...weights) < 0) {
          distance = Infinity;
          const corners = [a, b, c];
          for (let edge = 0; edge < 3; edge++) {
            const next = (edge + 1) % 3, p = corners[edge], q = corners[next];
            const dx = q[0] - p[0], dy = q[1] - p[1];
            const t = Math.max(0, Math.min(1, ((x + .5 - p[0]) * dx + (y + .5 - p[1]) * dy) / (dx * dx + dy * dy)));
            const squared = (x + .5 - p[0] - t * dx) ** 2 + (y + .5 - p[1] - t * dy) ** 2;
            if (squared >= distance) continue;
            distance = squared;
            positionWeights = [0, 0, 0]; positionWeights[edge] = 1 - t; positionWeights[next] = t;
          }
        }
        const index = y * SIZE + x;
        if (distance > 4 || distance >= distances[index]) continue;
        distances[index] = distance;
        const offset = index * 12;
        // Keep corner rays inside their chart instead of exactly on an adjoining wall.
        const inward = Math.max(0, ...positionWeights.map((w, j) => w < insetWeights[j] ? (insetWeights[j] - w) / (1 / 3 - w) : 0));
        if (inward > 0) positionWeights = positionWeights.map(w => w * (1 - inward) + inward / 3);
        // Extend smooth normals into padding, but keep ray origins on the mesh.
        const normal = [0, 1, 2].map(k => ids.reduce((sum, id, j) => sum + mesh.normals[id * 3 + k] * weights[j], 0));
        const length = Math.hypot(...normal);
        let color = material.color;
        if (material.diffuseTexture && mesh.albedoUvs) {
          const { size, pixels } = material.diffuseTexture;
          const uv = [0, 1].map(k => ids.reduce((sum, id, j) => sum + mesh.albedoUvs![id * 2 + k] * positionWeights[j], 0));
          const texel = uv.map(v => Math.floor((v - Math.floor(v)) * size));
          const sample = (texel[1] * size + texel[0]) * 4;
          color = color.map((v, k) => v * pixels[sample + k] / 255) as Vec3;
        }
        if (material.metallicTexture && mesh.metallicUvs) {
          const { size, pixels, factor, wrapU, wrapV } = material.metallicTexture;
          const texel = [wrapU, wrapV].map((wrap, k) => {
            const uv = ids.reduce((sum, id, j) => sum + mesh.metallicUvs![id * 2 + k] * positionWeights[j], 0);
            const repeat = uv - Math.floor(uv);
            const coord = wrap === Texture.CLAMP_ADDRESSMODE ? Math.max(0, Math.min(1, uv))
              : wrap === Texture.MIRROR_ADDRESSMODE && Math.abs(Math.floor(uv) % 2) === 1 ? 1 - repeat : repeat;
            return Math.min(size - 1, Math.floor(coord * size));
          });
          const metallic = factor * pixels[texel[1] * size + texel[0]] / 255;
          color = color.map(value => value * (1 - metallic)) as Vec3;
        }
        surfaces.set([...[0, 1, 2].map(k => points.reduce((sum, p, j) => sum + p[k] * positionWeights[j], 0)), 1,
          ...normal.map(n => n / length), 0, ...color, 0], offset);
      }
    }
  }
  return { surfaces, min, max, ...packBvh(buildBvh(triangles)) };
}

/** Fixed world-space interval probes, followed by an exact short-range surface gather. */
export class RadianceCascades {
  readonly texture: RawTexture;
  readonly memoryBytes: number;
  error = '';
  ready = false;
  revision = 0;
  private prepared = false;
  private cursor = 0;
  private preparationLevel = -1;
  private stage = 0;
  private bounce = 0;
  private activeBounces = 1;
  private completedBounces = 0;
  private updateStarted = 0;
  private lastUpdateWallMilliseconds = 0;
  private dirty = true;
  private pending?: { state: ReturnType<typeof lighting>; sky: Vec3; bounces: number };
  private buffers: StorageBuffer[] = [];
  private levels: Level[] = [];
  private shaders: Record<string, ComputeShader> = {};
  private params: UniformBuffer;
  private intervalCount = 0;

  constructor(scene: Scene, private engine: WebGPUEngine, data: SceneData) {
    if (data.fixtures.length !== 2) throw new Error('The cascade study expects the two fixed comparison lights.');
    const mesh = geometry(data);
    const origin = mesh.min.map(v => Math.floor(v * 2) / 2 - .5) as Vec3;
    for (let i = 0; i < 3; i++) {
      const spacing = .5 * 2 ** i;
      const dimensions = mesh.max.map((v, k) => Math.ceil((v - origin[k]) / spacing) + 1) as Vec3;
      const directions = 4 * 2 ** i;
      const count = dimensions.reduce((a, b) => a * b, 1) * directions * directions * 2;
      this.levels.push({ dimensions, spacing, start: NEAR * 3 ** i,
        end: i === 2 ? 24 : NEAR * 3 ** (i + 1), directions, offset: this.intervalCount, count });
      this.intervalCount += count;
    }
    const allocations: Record<string, StorageBuffer> = {};
    let bytes = SIZE * SIZE * 8;
    const buffer = (name: string, value: ArrayBuffer | Float32Array | number) => {
      const size = typeof value === 'number' ? value : value.byteLength;
      const result = new StorageBuffer(engine, size);
      if (typeof value !== 'number') result.update(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      this.buffers.push(result); allocations[name] = result; bytes += size;
    };
    buffer('nodes', mesh.nodes); buffer('triangles', mesh.triangles); buffer('surfaces', mesh.surfaces);
    buffer('hits', (this.intervalCount + SIZE * SIZE * RAYS) * 16);
    buffer('surfaceLight', SIZE * SIZE * 32);
    buffer('bounceLight', SIZE * SIZE * 32);
    buffer('cascades', this.intervalCount * 16);
    this.memoryBytes = bytes;
    this.texture = new RawTexture(null, SIZE, SIZE, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
      Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    this.texture.gammaSpace = false;
    this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.params = new UniformBuffer(engine);
    const fields = ['sun', 'sunColor', 'sky', 'lamp0', 'lampColor0', 'lamp1', 'lampColor1',
      'origin', 'dimensions', 'range', 'nextDimensions', 'nextRange', 'update', 'bounce'];
    fields.forEach(name => this.params.addUniform(name, 4)); this.params.create();
    this.params.updateFloat4('origin', ...origin, NEAR);
    this.params.updateFloat4('sky', 0, 0, 0, SIZE);
    data.fixtures.forEach((lamp, i) => {
      this.params.updateFloat4('lamp' + i, ...lamp.position, lamp.intensity);
      this.params.updateFloat4('lampColor' + i, ...lamp.color, 0);
    });
    const bindings = ['nodes', 'triangles', 'surfaces', 'params', 'hits', 'surfaceLight', 'cascades', 'output', 'bounceLight'];
    const entries: Record<string, string[]> = {
      prepareSurfaces: ['nodes', 'triangles', 'surfaces', 'params', 'hits', 'surfaceLight'],
      prepareIntervals: ['nodes', 'triangles', 'params', 'hits'],
      shade: ['nodes', 'triangles', 'surfaces', 'params', 'surfaceLight'],
      merge: ['params', 'hits', 'surfaceLight', 'cascades'],
      gather: ['surfaces', 'params', 'hits', 'surfaceLight', 'cascades', 'output', 'bounceLight'],
      advance: ['params', 'surfaceLight', 'bounceLight'],
    };
    for (const [entryPoint, names] of Object.entries(entries)) {
      const shader = new ComputeShader('Comparison RC ' + entryPoint, engine, { computeSource: source }, {
        entryPoint, bindingsMapping: Object.fromEntries(names.map(name => [name, { group: 0, binding: bindings.indexOf(name) }])),
      });
      for (const name of names) {
        if (name === 'params') shader.setUniformBuffer(name, this.params);
        else if (name === 'output') shader.setStorageTexture(name, this.texture);
        else shader.setStorageBuffer(name, allocations[name]);
      }
      shader.onError = (_effect, error) => { this.error = error; this.ready = false; };
      this.shaders[entryPoint] = shader;
    }
  }

  setLighting(state: ReturnType<typeof lighting>, sky: Vec3, bounces = 1) {
    this.pending = { state, sky, bounces: Math.max(1, Math.min(4, Math.round(bounces))) };
    this.dirty = true;
  }

  private level(index: number) {
    const current = this.levels[index], next = this.levels[Math.min(index + 1, 2)];
    this.params.updateFloat4('dimensions', ...current.dimensions, current.spacing);
    this.params.updateFloat4('range', current.start, current.end, current.directions, current.offset);
    this.params.updateFloat4('nextDimensions', ...next.dimensions, next.spacing);
    this.params.updateFloat4('nextRange', next.start, next.end, next.directions, next.offset);
  }

  tick() {
    if (this.error || (!this.dirty && this.prepared)) return;
    // A dispatch per frame keeps preparation bounded and separates writes to the shared uniform buffer.
    if (!this.prepared) {
      const surface = this.preparationLevel < 0;
      const total = surface ? SIZE * SIZE : this.levels[this.preparationLevel].count;
      const count = Math.min(surface ? 256 : 8192, total - this.cursor);
      if (!surface) this.level(this.preparationLevel);
      this.params.updateFloat4('update', this.cursor, count, this.intervalCount, 0); this.params.update();
      if (!this.shaders[surface ? 'prepareSurfaces' : 'prepareIntervals'].dispatch(Math.ceil(count / 64))) return;
      this.cursor += count;
      if (this.cursor === total) { this.cursor = 0; this.preparationLevel++; }
      this.prepared = this.preparationLevel === this.levels.length;
      return;
    }
    // Complete each snapshot while a dragged slider queues only its latest value.
    if (this.stage === 0 && this.bounce === 0 && this.pending) {
      const { state, sky, bounces } = this.pending;
      this.params.updateFloat4('sun', ...state.direction as Vec3, state.sun);
      this.params.updateFloat4('sunColor', ...state.color as Vec3, Number(state.on));
      this.params.updateFloat4('sky', ...sky.map(v => v * state.sky) as Vec3, SIZE);
      this.activeBounces = bounces;
      this.updateStarted = performance.now();
      this.pending = undefined;
    }
    if (this.stage > 0 && this.stage < 4) this.level(3 - this.stage);
    if (this.stage === 4) this.level(0);
    this.params.updateFloat4('update', 0, SIZE * SIZE, this.intervalCount, this.stage === 1 ? 1 : 0);
    this.params.updateFloat4('bounce', this.bounce, Number(this.bounce + 1 === this.activeBounces), 0, 0);
    this.params.update();
    const name = this.stage === 0 ? (this.bounce === 0 ? 'shade' : 'advance') : this.stage === 4 ? 'gather' : 'merge';
    const count = name === 'merge' ? this.levels[3 - this.stage].count : SIZE * SIZE;
    if (!this.shaders[name].dispatch(Math.ceil(count / 64))) return;
    if (++this.stage === 5) {
      this.stage = 0;
      if (++this.bounce < this.activeBounces) return;
      this.bounce = 0;
      this.completedBounces = this.activeBounces;
      this.lastUpdateWallMilliseconds = performance.now() - this.updateStarted;
      this.ready = true; this.dirty = !!this.pending; this.revision++;
    }
  }

  get status() {
    if (this.error) return 'Radiance cascades unavailable · baked fallback';
    if (!this.prepared) return 'Preparing cascade visibility';
    return this.dirty ? 'Updating radiance cascades'
      : `Radiance cascades · ${this.completedBounces} diffuse bounce${this.completedBounces === 1 ? '' : 's'}`;
  }

  diagnostics() {
    return { ready: this.ready, updating: this.dirty, revision: this.revision, error: this.error,
      requestedBounces: this.pending?.bounces ?? this.activeBounces, completedBounces: this.completedBounces,
      lastUpdateDispatches: this.completedBounces * 5, lastUpdateWallMilliseconds: this.lastUpdateWallMilliseconds,
      atlasSize: SIZE, surfaceRays: RAYS, intervalRays: this.intervalCount, memoryBytes: this.memoryBytes,
      lastDispatchGpuMilliseconds: Object.fromEntries(Object.entries(this.shaders).map(([name, shader]) =>
        [name, shader.gpuTimeInFrame ? shader.gpuTimeInFrame.counter.current / 1e6 : null])) };
  }

  dispose() {
    this.buffers.forEach(buffer => buffer.dispose());
    this.params.dispose(); this.texture.dispose();
  }
}
