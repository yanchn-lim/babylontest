import { Mesh, Vector3, type PBRMaterial } from '@babylonjs/core';
import type { ReflectionRoom } from '../comparison/reflections';

// X/Z room limits also partition the shared floor and wall meshes for local maps.
const regions = [
  { name: 'Living room', bounds: [8.8, 12.4, -8.7, -4.4] },
  { name: 'Bedroom west', bounds: [0, 3.1, -9, -4.4] },
  { name: 'Bedroom middle', bounds: [3.1, 5.85, -9, -5.55] },
  { name: 'Bedroom east', bounds: [5.85, 8.8, -9, -5.55] },
  { name: 'Bathroom west', bounds: [1.2, 3.55, -4.4, -2.5] },
  { name: 'Bathroom east', bounds: [3.55, 5.85, -4.4, -2.5] },
  { name: 'Kitchen', bounds: [5.85, 8.8, -3, -.3] },
  { name: 'Shelter', bounds: [10.6, 12.4, -4.4, -1.5] },
];

type Polygon = number[][];
function split(polygon: Polygon, axis: number, plane: number, sign: number): [Polygon, Polygon] {
  const distances = polygon.map(point => (point[axis] - plane) * sign);
  if (distances.every(distance => distance >= 0)) return [polygon, []];
  if (distances.every(distance => distance <= 0)) return [[], polygon];
  const inside: Polygon = [], outside: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = (a[axis] - plane) * sign, db = (b[axis] - plane) * sign;
    if (da >= 0) inside.push(a);
    if (da <= 0) outside.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db), point = a.map((v, k) => v + (b[k] - v) * t);
      point[axis] = plane;
      inside.push(point); outside.push(point);
    }
  }
  return [inside, outside];
}

/** Split only the render geometry. Interpolate every UV set, preserving the GI cache. */
export function apartmentReflectionRooms(sources: Mesh[], sourceMaterials: PBRMaterial[]) {
  const rooms: ReflectionRoom[] = regions.map(({ name, bounds: [x0, x1, z0, z1] }) => ({
    name, center: [(x0 + x1) / 2, 1.375, (z0 + z1) / 2], size: [x1 - x0, 2.75, z1 - z0], materials: [],
  }));
  rooms.push({ name: 'Hall', center: [6.8, 1.375, -4.6], size: [7.4, 2.75, 2.5], materials: [] });
  const meshes: Mesh[] = [], materials: PBRMaterial[] = [];
  for (const source of sources) {
    const kinds = ['position', ...source.getVerticesDataKinds().filter(kind => kind !== 'position')];
    const attributes = kinds.map(kind => ({ kind, size: source.getVertexBuffer(kind)!.getSize(), values: source.getVerticesData(kind)! }));
    const stride = attributes.reduce((sum, a) => sum + a.size, 0);
    const vertices = Array.from({ length: source.getTotalVertices() }, (_, i) => attributes.flatMap(a => Array.from(a.values.slice(i * a.size, (i + 1) * a.size))));
    const world = source.computeWorldMatrix(true), normalMatrix = world.clone().invert().transpose();
    for (const vertex of vertices) {
      let offset = 0;
      for (const attribute of attributes) {
        if (attribute.kind === 'position' || attribute.kind === 'normal' || attribute.kind === 'tangent') {
          const value = Vector3.FromArray(vertex, offset);
          const transformed = attribute.kind === 'position' ? Vector3.TransformCoordinates(value, world)
            : Vector3.TransformNormal(value, normalMatrix).normalize();
          vertex.splice(offset, 3, ...transformed.asArray());
        }
        offset += attribute.size;
      }
    }
    const buckets: Polygon[] = rooms.map(() => []), indices = source.getIndices()!;
    const append = (polygon: Polygon, room: number) => {
      for (let i = 1; i + 1 < polygon.length; i++) buckets[room].push(polygon[0], polygon[i], polygon[i + 1]);
    };
    for (let face = 0; face < indices.length; face += 3) {
      let remaining: Polygon[] = [[vertices[indices[face]], vertices[indices[face + 1]], vertices[indices[face + 2]]]];
      regions.forEach(({ bounds: [x0, x1, z0, z1] }, room) => {
        const outside: Polygon[] = [];
        for (let polygon of remaining) {
          for (const [axis, plane, sign] of [[0, x0, 1], [0, x1, -1], [2, z0, 1], [2, z1, -1]]) {
            const parts = split(polygon, axis, plane, sign);
            if (parts[1].length >= 3) outside.push(parts[1]);
            polygon = parts[0];
            if (polygon.length < 3) break;
          }
          append(polygon, room);
        }
        remaining = outside;
      });
      remaining.forEach(polygon => append(polygon, rooms.length - 1));
    }
    buckets.forEach((vertices, room) => {
      if (!vertices.length) return;
      const material = (source.material as PBRMaterial).clone(source.material!.name + ' · ' + rooms[room].name);
      rooms[room].materials.push(material); materials.push(material);
      const mesh = new Mesh(source.name + ' · ' + rooms[room].name, source.getScene());
      let offset = 0;
      for (const attribute of attributes) {
        mesh.setVerticesData(attribute.kind, vertices.flatMap(v => v.slice(offset, offset + attribute.size)), false, attribute.size);
        offset += attribute.size;
      }
      if (offset !== stride) throw Error('Invalid apartment vertex layout.');
      mesh.setIndices(Array.from({ length: vertices.length }, (_, i) => i));
      mesh.material = material; mesh.sideOrientation = source.sideOrientation;
      mesh.receiveShadows = true; mesh.checkCollisions = true; meshes.push(mesh);
    });
    source.dispose(false, false);
  }
  sourceMaterials.forEach(material => material.dispose(false, false));
  return { meshes, materials, rooms };
}
