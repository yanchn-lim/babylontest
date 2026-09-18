interface ReflectionGeometry { materials: { transmitting?: boolean }[]; meshes: { positions: number[]; indices: number[]; material: number }[] }

export interface ReflectionBox { min: number[]; max: number[] }
const bounds = (points: number[][]): ReflectionBox => {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of points) for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], p[k]); box.max[k] = Math.max(box.max[k], p[k]); }
  return box;
};

/** Accept only separate, closed axis-aligned boxes, never a mesh's loose bounds. */
export function localReflectionBoxes(data: ReflectionGeometry, receiver?: ReflectionGeometry['meshes'][number]) {
  const receiverBounds = receiver && bounds(Array.from({ length: receiver.positions.length / 3 }, (_, i) => receiver.positions.slice(i * 3, i * 3 + 3)));
  const result: ReflectionBox[] = [];
  for (const mesh of data.meshes) {
    if (mesh === receiver || data.materials[mesh.material].transmitting) continue;
    const parents = Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
    const root = (i: number): number => parents[i] === i ? i : parents[i] = root(parents[i]);
    const vertices = new Map<string, number>();
    const faces = parents.map((_, face) => mesh.indices.slice(face * 3, face * 3 + 3).map(i => mesh.positions.slice(i * 3, i * 3 + 3)));
    faces.forEach((points, face) => points.forEach(p => {
      const key = p.map(v => v.toFixed(5)).join(',');
      const other = vertices.get(key);
      if (other === undefined) vertices.set(key, face); else parents[root(face)] = root(other);
    }));
    const groups = new Map<number, number[][][]>();
    faces.forEach((points, face) => { const key = root(face); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(points); });
    for (const triangles of groups.values()) {
      if (triangles.length !== 12) continue;
      const box = bounds(triangles.flat()), size = box.max.map((v, k) => v - box.min[k]);
      if (size.some(v => v < .00001)) continue;
      const corners = new Set<string>(), sides: number[][][] = Array.from({ length: 6 }, () => []);
      let valid = true;
      for (const triangle of triangles) {
        const ids = triangle.map(p => {
          let id = 0;
          for (let k = 0; k < 3; k++) {
            if (Math.abs(p[k] - box.max[k]) < .00001) id |= 1 << k;
            else if (Math.abs(p[k] - box.min[k]) >= .00001) valid = false;
          }
          corners.add(String(id)); return id;
        });
        const side = [0, 1, 2, 3, 4, 5].find(s => ids.every(id => ((id >> (s >> 1)) & 1) === (s & 1)));
        if (side === undefined || new Set(ids).size !== 3) valid = false;
        else sides[side].push(ids);
      }
      // Two triangles per face must share a diagonal and cover all four corners.
      valid &&= corners.size === 8 && sides.every(side => {
        if (side.length !== 2 || new Set(side.flat()).size !== 4) return false;
        const shared = side[0].filter(i => side[1].includes(i));
        const diagonal = shared[0] ^ shared[1];
        return shared.length === 2 && [3, 5, 6].includes(diagonal);
      });
      const distance = receiverBounds ? Math.hypot(...box.min.map((v, k) => Math.max(0, v - receiverBounds.max[k], receiverBounds.min[k] - box.max[k]))) : 0;
      if (valid && distance <= 1.5) result.push(box);
    }
  }
  return result;
}
