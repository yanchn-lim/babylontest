import { LightingAtlasCache } from './lighting-atlas-cache';
import type { AtlasGeometry } from './lighting-charts';
import type { LightingAllocation, LightingLayout } from '../comparison/transfer-layout';
import { transferLayout } from '../comparison/transfer-layout';
import { hasLightingArea } from './lighting-geometry';

/** Fixed apartment page plus stable, independently packed furniture allocations. UVs use 256px units. */
export async function generateLightingPages(geometry: AtlasGeometry[], groups: ReadonlyMap<string, readonly number[]>, options: {
  previousLayout?: LightingLayout; signal?: AbortSignal; onProgress?: (fraction: number) => void;
  atlasCache?: LightingAtlasCache; furnitureGeometry?: ReadonlyMap<string, AtlasGeometry[]>;
}) {
  options.signal?.throwIfAborted();
  if (options.previousLayout) transferLayout({ lightingLayout: options.previousLayout });
  for (const mesh of geometry) {
    if (!mesh.positions.length || mesh.positions.length % 9 || mesh.normals.length !== mesh.positions.length
      || !mesh.positions.every(Number.isFinite) || !mesh.normals.every(Number.isFinite)) throw Error('Invalid lighting geometry.');
    for (let i = 0; i < mesh.normals.length; i += 3) {
      if (Math.hypot(...mesh.normals.slice(i, i + 3)) < 1e-6) throw Error('Invalid lighting surface normal.');
    }
  }
  const owned = new Set<number>();
  for (const [id, indices] of groups) {
    if (!id || !indices.length) throw Error('A furniture allocation needs an ID and meshes.');
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= geometry.length || owned.has(i)) throw Error('Invalid or repeated furniture allocation mesh.');
      owned.add(i);
    }
  }
  const atlas = geometry.map(mesh => new Array<number>(mesh.positions.length / 3 * 2).fill(0));
  const architecture = geometry.flatMap((mesh, i) => !owned.has(i) && !mesh.transmitting ? [i] : []);
  const cache = options.atlasCache ?? new LightingAtlasCache();
  const stats = { architectureCharts: 0, charts: 0, size: 256, height: 256, ignoredTriangles: 0, furnitureAllocations: 0,
    atlasBuilds: 0, atlasCacheHits: 0, packingAttempts: 0 };
  const record = (result: Awaited<ReturnType<LightingAtlasCache['generate']>>) => {
    if (result.reused) stats.atlasCacheHits++;
    else { stats.atlasBuilds++; stats.packingAttempts += result.stats.packingAttempts; }
  };
  if (architecture.length) {
    const result = await cache.generate(architecture.map(i => geometry[i]), false, 256, options.signal);
    architecture.forEach((mesh, i) => { atlas[mesh] = result.atlas[i]; });
    stats.architectureCharts = result.stats.architectureCharts; stats.charts = result.stats.charts;
    stats.ignoredTriangles = result.stats.ignoredTriangles; record(result);
  }
  options.onProgress?.(1 / (groups.size + 1));
  const previous = options.previousLayout?.allocations ?? [];
  const reserved: LightingAllocation[] = [];
  for (const slot of previous) {
    if (!slot.id || reserved.some(other => other.id === slot.id) || ![64,128,256].includes(slot.size)
      || !Number.isInteger(slot.x) || !Number.isInteger(slot.y) || slot.x < 0 || slot.y < 256
      || slot.x % 64 || slot.y % 64 || slot.x + slot.size > 256 || slot.y + slot.size > options.previousLayout!.height) throw Error('Invalid previous furniture allocation.');
    if (reserved.some(other => overlaps(slot, other))) throw Error('Previous furniture allocations overlap.');
    reserved.push({ ...slot });
  }
  const occupied = reserved.filter(slot => groups.has(slot.id));
  const allocations: LightingAllocation[] = [];
  for (const [id, meshes] of groups) {
    options.signal?.throwIfAborted();
    const opaque = meshes.filter(i => !geometry[i].transmitting);
    const old = occupied.find(slot => slot.id === id);
    const valid = opaque.map(i => {
      const p = geometry[i].positions;
      return Array.from({ length: p.length / 9 }, (_, face) => {
        const start = face * 9;
        return hasLightingArea(p.slice(start, start + 3), p.slice(start + 3, start + 6), p.slice(start + 6, start + 9));
      });
    });
    if (!valid.some(faces => faces.some(Boolean))) {
      stats.ignoredTriangles += valid.reduce((sum, faces) => sum + faces.length, 0);
      if (old) occupied.splice(occupied.indexOf(old), 1);
      continue;
    }
    const canonical = options.furnitureGeometry?.get(id);
    const unwrap = opaque.map(i => canonical ? canonical[meshes.indexOf(i)] : geometry[i]);
    const origin = unwrap[0].positions.slice(0, 3);
    // xatlas uses absolute tolerances. Millimetres retain small valid catalogue faces.
    const local = unwrap.map((mesh, i) => ({ ...mesh, positions: mesh.positions.map((value, corner) =>
      valid[i][Math.floor(corner / 9)] ? (value - origin[corner % 3]) * 1000 : 0) }));
    let result: Awaited<ReturnType<LightingAtlasCache['generate']>>;
    try { result = await cache.generate(local, true, old?.size ?? 64, options.signal); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw Error(`Furniture ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const size = result.stats.size; record(result);
    let slot = old;
    if (!slot || slot.size !== size) {
      if (slot) occupied.splice(occupied.indexOf(slot), 1);
      slot = allocate(id, size, occupied); occupied.push(slot);
    }
    allocations.push({ ...slot });
    opaque.forEach((mesh, i) => {
      atlas[mesh] = result.atlas[i].map((v, corner) => valid[i][Math.floor(corner / 6)]
        ? (v * size + (corner % 2 ? slot!.y : slot!.x)) / 256 : 0);
    });
    stats.charts += result.stats.charts; stats.ignoredTriangles += result.stats.ignoredTriangles;
    options.onProgress?.((allocations.length + 1) / (groups.size + 1));
  }
  if (!stats.charts) throw Error('No opaque lighting geometry.');
  const height = Math.max(256, ...allocations.map(slot => slot.y + slot.size));
  const layout: LightingLayout = { version: 1, width: 256, height, allocations };
  stats.height = height; stats.furnitureAllocations = allocations.length;
  options.onProgress?.(1);
  return { atlas, layout, stats };
}

function overlaps(a: LightingAllocation, b: LightingAllocation) {
  return a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;
}
function allocate(id: string, size: number, occupied: LightingAllocation[]) {
  for (let y = 256; y + size <= 8192; y += 64) for (let x = 0; x + size <= 256; x += 64) {
    const slot = { id, x, y, size };
    if (!occupied.some(other => overlaps(slot, other))) return slot;
  }
  throw Error('Furniture lighting exceeds the 256×8192 atlas budget.');
}
