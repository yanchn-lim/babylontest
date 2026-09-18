import createXAtlas, { type XAtlasModule } from 'xatlas-wasm';
import { architecturalCharts, chartCoordinates, type AtlasGeometry } from './lighting-charts';
import { hasLightingArea, lightingIndices } from './lighting-geometry';

let modulePromise: Promise<XAtlasModule> | undefined;

/** Validate the final resolution, including collisions between distinct chart interiors. */
export function validateLightingAtlas(geometry: AtlasGeometry[], atlas: number[][], charts: number[][], size: number) {
  if (!Number.isInteger(size) || size < 8) throw Error('Invalid lighting atlas resolution.');
  if (atlas.length !== geometry.length || charts.length !== geometry.length) throw Error('Lighting atlas mesh count mismatch.');
  const owners = new Int32Array(size * size).fill(-1);
  geometry.forEach((mesh, index) => {
    const uv = atlas[index], ids = charts[index];
    if (uv.length !== mesh.positions.length / 3 * 2 || ids.length !== mesh.positions.length / 9
      || uv.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw Error('Invalid lighting coordinates.');
    if (mesh.transmitting) return;
    for (let face = 0; face < ids.length; face++) {
      const [p, q, r] = [0, 1, 2].map(j => mesh.positions.slice((face * 3 + j) * 3, (face * 3 + j + 1) * 3));
      if (!hasLightingArea(p, q, r)) continue;
      if (ids[face] < 0) throw Error(`A surface has no lighting chart (mesh ${index}, face ${face}).`);
      const [a, b, c] = [0, 1, 2].map(j => uv.slice((face * 3 + j) * 2, (face * 3 + j + 1) * 2).map(v => v * size));
      const area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(area) < 1e-10) throw Error(`A lighting triangle has collapsed (mesh ${index}, face ${face}).`);
      const lo = [0, 1].map(k => Math.max(0, Math.floor(Math.min(a[k], b[k], c[k]))));
      const hi = [0, 1].map(k => Math.min(size - 1, Math.ceil(Math.max(a[k], b[k], c[k]))));
      for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const u = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / area;
        const v = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / area;
        if (Math.min(u, v, 1 - u - v) <= 1e-6) continue;
        const pixel = y * size + x;
        if (owners[pixel] !== -1 && owners[pixel] !== ids[face]) throw Error('Lighting charts overlap at the renderer resolution.');
        owners[pixel] = ids[face];
      }
    }
  });
}

/** Returns triangle-order UVs. Does not change model geometry, materials or native UVs. */
export async function generateLightingAtlas(geometry: AtlasGeometry[], furniture: ReadonlySet<number>, options: {
  size: number; maxSize?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void;
}) {
  const { signal, onProgress = () => {}, maxSize = options.size } = options;
  let size = options.size;
  if (!Number.isInteger(size) || size < 8 || !Number.isInteger(maxSize) || maxSize < size) throw Error('Invalid lighting atlas resolution.');
  signal?.throwIfAborted();
  if ([...furniture].some(i => !Number.isInteger(i) || i < 0 || i >= geometry.length)) throw Error('Invalid furniture mesh index.');
  for (const mesh of geometry) {
    if (!mesh.positions.length || mesh.positions.length % 9 || mesh.normals.length !== mesh.positions.length
      || !mesh.positions.every(Number.isFinite) || !mesh.normals.every(Number.isFinite)) throw Error('Invalid lighting geometry.');
    for (let i = 0; i < mesh.normals.length; i += 3) {
      if (Math.hypot(...mesh.normals.slice(i, i + 3)) < 1e-6) throw Error('Invalid lighting surface normal.');
    }
  }
  const charts = architecturalCharts(geometry, furniture, signal);
  const module = await (modulePromise ??= createXAtlas()), packed = module.createAtlas();
  const atlas = geometry.map(mesh => new Array<number>(mesh.positions.length / 3 * 2).fill(0));
  const chartIds = geometry.map(mesh => new Array<number>(mesh.positions.length / 9).fill(-1));
  const validCorners = geometry.map(mesh => mesh.transmitting ? [] : lightingIndices(mesh.positions,
    Array.from({ length: mesh.positions.length / 3 }, (_, i) => i)));
  const ignoredTriangles = geometry.reduce((count, mesh, i) => count + (mesh.transmitting ? 0 : (mesh.positions.length / 3 - validCorners[i].length) / 3), 0);
  const furnitureIndices = [...furniture].filter(i => validCorners[i].length);
  try {
    packed.setProgressCallback((_stage, progress) => { onProgress(progress / 100); return !signal?.aborted; });
    for (const chart of charts) {
      signal?.throwIfAborted();
      const [w, h] = chart.extent;
      // One mesh per architectural chart prevents xatlas from joining separated rooms.
      if (packed.addMesh({ positions: new Float32Array([0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]) })) throw Error('Could not add an architectural chart.');
    }
    for (const i of furnitureIndices) {
      signal?.throwIfAborted();
      const corners = validCorners[i];
      if (packed.addMesh({ positions: Float32Array.from(corners.flatMap(corner => geometry[i].positions.slice(corner * 3, corner * 3 + 3))),
        normals: Float32Array.from(corners.flatMap(corner => geometry[i].normals.slice(corner * 3, corner * 3 + 3))) })) throw Error('Could not unwrap furniture mesh ' + i);
    }
    if (!packed.meshCount && !charts.length && !furnitureIndices.length) throw Error('No opaque lighting geometry.');
    packed.computeCharts({});
    signal?.throwIfAborted();
    let packingAttempts = 0;
    for (; size <= maxSize; size *= 2) {
      packed.packCharts({ resolution: size, padding: 2, bilinear: true }); packingAttempts++;
      signal?.throwIfAborted();
      let density = packed.texelsPerUnit;
      for (let attempt = 0; attempt < 24 && (packed.atlasCount !== 1 || packed.width > size || packed.height > size); attempt++) {
        density *= .8;
        packed.packCharts({ resolution: size, texelsPerUnit: density, padding: 2, bilinear: true }); packingAttempts++;
        signal?.throwIfAborted();
      }
      if (packed.atlasCount === 1 && packed.width <= size && packed.height <= size) break;
    }
    if (size > maxSize) throw Error(`This scene exceeds the ${maxSize}px lighting atlas capacity.`);
    charts.forEach((chart, i) => {
      const output = packed.getMesh(i), corners = [0, 1, 3].map(id => output.vertices.find(v => v.xref === id));
      if (output.chartCount !== 1 || corners.some(v => !v || v.atlasIndex !== 0)) throw Error('Architectural chart was split during packing.');
      const [origin, du, dv] = corners.map(v => v!.uv);
      for (const face of chart.faces) {
        chartIds[face.mesh][face.corner / 3] = corners[0]!.chartIndex;
        face.points.forEach((point, j) => {
          const [u, v] = chartCoordinates(chart, point);
          for (let k = 0; k < 2; k++) atlas[face.mesh][(face.corner + j) * 2 + k] = (origin[k] + u * (du[k] - origin[k]) + v * (dv[k] - origin[k])) / size;
        });
      }
    });
    furnitureIndices.forEach((mesh, i) => {
      const output = packed.getMesh(charts.length + i);
      const corners = validCorners[mesh];
      if (output.indices.length !== corners.length) throw Error('Furniture triangle count changed during unwrapping.');
      output.indices.forEach((index, compactCorner) => {
        const vertex = output.vertices[index];
        if (vertex.xref !== compactCorner) throw Error('Furniture triangle order changed during unwrapping.');
        const corner = corners[compactCorner];
        if (vertex.atlasIndex < 0) return;
        if (vertex.atlasIndex !== 0) throw Error('Furniture lies outside the lighting atlas.');
        atlas[mesh][corner * 2] = vertex.uv[0] / size; atlas[mesh][corner * 2 + 1] = vertex.uv[1] / size;
        chartIds[mesh][Math.floor(corner / 3)] = vertex.chartIndex;
      });
    });
    validateLightingAtlas(geometry, atlas, chartIds, size);
    return { atlas, stats: { architectureCharts: charts.length, charts: packed.chartCount, size, ignoredTriangles, packingAttempts } };
  } finally { packed.destroy(); }
}
