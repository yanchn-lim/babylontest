import { Texture } from '@babylonjs/core';
import { buildBvh, packBvh, type Triangle } from '../interior-lighting/bvh';
import type { SceneData } from './main';
type Vec3 = [number, number, number];
const SIZE = 256;

// Connected world/UV vertices identify lighting regions without joining atlas seams.
function lightingCharts(mesh: SceneData['meshes'][number]) {
  const parents = Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : parents[i] = root(parents[i]);
  const vertices = new Map<string, number>();
  for (let face = 0; face < parents.length; face++) {
    for (const index of mesh.indices.slice(face * 3, face * 3 + 3)) {
      const key = [...mesh.positions.slice(index * 3, index * 3 + 3), ...mesh.uvs.slice(index * 2, index * 2 + 2)]
        .map(value => value.toFixed(6)).join(',');
      const neighbour = vertices.get(key);
      if (neighbour === undefined) vertices.set(key, face);
      else parents[root(face)] = root(neighbour);
    }
  }
  return parents.map((_, face) => root(face));
}

export function geometry(data: SceneData, labelCharts = false) {
  const rayOrigins = data.sampleRepair ? new Float32Array(SIZE * SIZE * 4) : undefined;
  const sampleFaces = new Int32Array(SIZE * SIZE).fill(-1);
  const surfaces = new Float32Array(SIZE * SIZE * 12);
  const distances = new Float32Array(SIZE * SIZE).fill(Infinity);
  const triangles: Triangle[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let chartOffset = 1;
  for (const mesh of data.meshes) {
    const material = data.materials[mesh.material];
    if (material.transmitting) continue;
    const charts = labelCharts ? lightingCharts(mesh) : [];
    const position = (i: number) => mesh.positions.slice(i * 3, i * 3 + 3) as Vec3;
    for (let face = 0; face < mesh.indices.length; face += 3) {
      const ids = mesh.indices.slice(face, face + 3);
      const points = ids.map(position);
      const insetWeights = points.map((p, j) => {
        if (!data.surfaceInset || data.sampleRepair) return 0;
        const a = points[(j + 1) % 3].map((v, k) => v - p[k]);
        const b = points[(j + 2) % 3].map((v, k) => v - p[k]);
        const twiceArea = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
        const height = twiceArea / Math.hypot(...a.map((v, k) => v - b[k]));
        return Math.min(1 / 3, data.surfaceInset / height);
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
        const normalWeights = data.sampleRepair ? positionWeights : weights;
        const normal = [0, 1, 2].map(k => ids.reduce((sum, id, j) => sum + mesh.normals[id * 3 + k] * normalWeights[j], 0));
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
        if (rayOrigins) {
          const edgeA = points[1].map((v, k) => v - points[0][k]), edgeB = points[2].map((v, k) => v - points[0][k]);
          const faceNormal = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
          const point = [0, 1, 2].map(k => points.reduce((sum, p, j) => sum + p[k] * positionWeights[j], 0));
          const minimum = Math.max(.00001, ...point.map(v => Math.abs(v) * .000001));
          const faceLength = Math.hypot(...faceNormal);
          rayOrigins.set([...point.map((v, k) => v + faceNormal[k] / faceLength * minimum * 4), minimum], index * 4);
          sampleFaces[index] = mesh === data.meshes[data.sampleRepair!.mesh] ? face / 3 : -1;
        }
        surfaces.set([...[0, 1, 2].map(k => points.reduce((sum, p, j) => sum + p[k] * positionWeights[j], 0)), 1,
          ...normal.map(n => n / length), 0, ...color, labelCharts ? chartOffset + charts[face / 3] : 0], offset);
      }
    }
    chartOffset += mesh.indices.length / 3;
  }
  return { surfaces, rayOrigins, sampleFaces, min, max, ...packBvh(buildBvh(triangles)) };
}

