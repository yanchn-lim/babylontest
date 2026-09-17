import type { SceneData } from './main';

/** Fixed comparison room without the original props. */
export function furnitureRoom(base: SceneData): SceneData {
  const data = structuredClone(base);
  data.surfaceInset = .008;
  data.references = [];
  data.meshes = data.meshes.filter(mesh => mesh.material === 1 || mesh.material === 2);
  // The plaster mesh also contains the original sphere pedestal; remove that prop.
  for (const mesh of data.meshes.filter(mesh => mesh.material === 2)) {
    const indices: number[] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const face = mesh.indices.slice(i, i + 3);
      if (face.some(id => Math.abs(mesh.positions[id * 3]) > 2.5 || mesh.positions[id * 3 + 1] > 2.8
        || Math.abs(mesh.positions[id * 3 + 2]) > 2.5)) indices.push(...face);
    }
    mesh.indices = indices;
  }
  data.meshes.forEach(mesh => { mesh.uvs = mesh.uvs.map(value => value * .4); });
  return data;
}
