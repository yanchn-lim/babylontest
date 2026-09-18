import type { SceneData } from './main';

export function transferRayDistance(data: Pick<SceneData, 'rayDistance'>) {
  const distance = data.rayDistance ?? 24;
  if (!(distance > 0) || !Number.isFinite(Math.fround(distance)) || Math.fround(distance) === 0) {
    throw Error('Lighting ray distance must be a finite positive GPU float.');
  }
  return distance;
}

/** Covers all opaque blockers, including the ray origin's normal offset. */
export function sceneRayDistance(data: Pick<SceneData, 'meshes' | 'materials'>) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of data.meshes) {
    if (data.materials[mesh.material].transmitting) continue;
    for (let i = 0; i < mesh.positions.length; i++) {
      const value = mesh.positions[i], axis = i % 3;
      if (!Number.isFinite(value)) throw Error('Lighting geometry must contain finite positions.');
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  const diagonal = Math.hypot(...max.map((value, axis) => value - min[axis]));
  return transferRayDistance({ rayDistance: diagonal + Math.max(.01, diagonal * 1e-6) });
}
