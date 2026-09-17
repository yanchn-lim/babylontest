import type { SceneData } from './main';

type Vec3 = [number, number, number];

/** Same positions, normals and UV charts at either tessellation density. */
export function offsetStudy(base: SceneData, dense: boolean): SceneData {
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
  const material = data.materials.length;
  data.materials.push({ name: 'Matte furniture test', color: [.62, .62, .62], roughness: .85 });
  let chart = 0;
  function box(lo: Vec3, hi: Vec3) {
    const mesh: SceneData['meshes'][number] = { material, positions: [], normals: [], uvs: [], indices: [] };
    const p = Array.from({ length: 8 }, (_, i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    for (const [a, b, , d] of faces) {
      const u = p[b].map((v, k) => v - p[a][k]), v = p[d].map((v, k) => v - p[a][k]);
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...normal), widths = [Math.hypot(...u), Math.hypot(...v)];
      const steps = dense && Math.min(...widths) / Math.max(...widths) > .08 ? 16 : 1;
      // Each face retains exactly the same atlas allocation at both densities.
      const x = .44 + chart % 8 * .07, y = Math.floor(chart / 8) * .1;
      chart++;
      for (let row = 0; row < steps; row++) for (let col = 0; col < steps; col++) {
        for (const [du, dv] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
          const s = (col + du) / steps, t = (row + dv) / steps;
          mesh.positions.push(...p[a].map((value, k) => value + u[k] * s + v[k] * t));
          mesh.normals.push(...normal.map(value => value / length));
          mesh.uvs.push(x + .008 + s * .054, y + .008 + t * .084);
          mesh.indices.push(mesh.indices.length);
        }
      }
    }
    data.meshes.push(mesh);
  }
  // A tabletop, a thin backrest and four legs, with millimetre-scale joins.
  box([-.6, .82, -1.1], [.6, .838, -.3]);
  box([-.6, .841, -1.11], [.6, 1.42, -1.098]);
  for (const x of [-.55, .51]) for (const z of [-1.04, -.39]) box([x, 0, z], [x + .04, .817, z + .04]);
  // Sealed 2 mm cavity: its inner faces must not see sky through the 1 mm shell.
  box([.85, .8, -.9], [1.25, .801, -.5]);
  box([.85, .803, -.9], [1.25, .804, -.5]);
  box([.85, .801, -.9], [.851, .803, -.5]);
  box([1.249, .801, -.9], [1.25, .803, -.5]);
  box([.851, .801, -.9], [1.249, .803, -.899]);
  box([.851, .801, -.501], [1.249, .803, -.5]);
  if (chart > 80) throw Error('Offset study atlas is full.');
  data.views.room = { position: [1.9, 1.65, 1.6], target: [.1, .8, -.75], fov: .85 };
  data.views.doorway = { position: [.85, 1.12, -.05], target: [0, .86, -.9], fov: .8 };
  return data;
}
