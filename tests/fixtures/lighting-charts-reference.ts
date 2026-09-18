// Frozen all-pairs reference for chart membership, order and boundary regression checks.
import { hasLightingArea } from '../../src/apartment/lighting-geometry';

/** World-space, triangle-order geometry used only for lighting preparation. */
export interface AtlasGeometry {
  positions: number[];
  normals: number[];
  transmitting: boolean;
}
type Point = [number, number, number];
interface Face {
  mesh: number;
  corner: number;
  points: Point[];
  normal: Point;
  distance: number;
  bounds: [number, number][];
}
export interface LightingChart {
  faces: Face[];
  u: Point;
  v: Point;
  lo: number[];
  extent: number[];
}
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Point, s: number): Point => [a[0] * s, a[1] * s, a[2] * s];
const length = (a: Point) => Math.hypot(...a);
const unit = (a: Point) => scale(a, 1 / length(a));

// Includes partial shared edges at T-junctions, as in prepare-apartment-atlas.py.
function sharedEdge(a: Point[], b: Point[]) {
  for (let i = 0; i < 3; i++) {
    const p = a[i], edge = subtract(a[(i + 1) % 3], p), direction = unit(edge);
    for (let j = 0; j < 3; j++) {
      const r = subtract(b[j], p), s = subtract(b[(j + 1) % 3], p);
      if (Math.max(length(cross(r, direction)), length(cross(s, direction))) > 1e-5) continue;
      const lo = Math.max(0, Math.min(dot(r, direction), dot(s, direction)));
      const hi = Math.min(length(edge), Math.max(dot(r, direction), dot(s, direction)));
      if (hi - lo > 1e-5) return p.map((v, k) => v + direction[k] * (lo + hi) / 2) as Point;
    }
  }
  return undefined;
}

function blocked(edge: Point, normal: Point, blockers: Face[]) {
  const point = edge.map((v, k) => v + normal[k] * .008) as Point;
  return blockers.some(face => {
    if (Math.abs(dot(normal, face.normal)) > .9999 || Math.abs(dot(face.normal, point) - face.distance) > 1e-5) return false;
    if (face.bounds.some(([lo, hi], k) => point[k] < lo - 1e-5 || point[k] > hi + 1e-5)) return false;
    // Accept either winding; the receiving normal can oppose the geometric normal.
    const sides = face.points.map((p, i) => dot(face.normal,
      cross(subtract(face.points[(i + 1) % 3], p), subtract(point, p))));
    return sides.every(v => v >= -1e-6) || sides.every(v => v <= 1e-6);
  });
}

/** Connected coplanar architecture, separated wherever a shared edge meets a wall. */
export function architecturalCharts(geometry: AtlasGeometry[], furniture: ReadonlySet<number>, signal?: AbortSignal) {
  const groups = new Map<string, Face[]>(), blockers: Face[] = [];
  geometry.forEach((mesh, meshIndex) => {
    if (mesh.transmitting || furniture.has(meshIndex)) return;
    for (let corner = 0; corner < mesh.positions.length / 3; corner += 3) {
      const points = [0, 1, 2].map(j => mesh.positions.slice((corner + j) * 3, (corner + j + 1) * 3) as Point);
      const geometric = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
      if (!hasLightingArea(points[0], points[1], points[2])) continue;
      let normal = unit(geometric);
      if (dot(normal, mesh.normals.slice(corner * 3, corner * 3 + 3) as Point) < 0) normal = scale(normal, -1);
      const distance = dot(normal, points[0]);
      const key = [...normal, distance].map(v => Math.round(v * 1e4)).join(',');
      const face: Face = { mesh: meshIndex, corner, points, normal, distance,
        bounds: [0, 1, 2].map(k => [Math.min(...points.map(p => p[k])), Math.max(...points.map(p => p[k]))]) };
      const group = groups.get(key) ?? []; group.push(face); groups.set(key, group); blockers.push(face);
    }
  });
  const charts: LightingChart[] = [];
  for (const faces of groups.values()) {
    signal?.throwIfAborted();
    const parents = faces.map((_, i) => i);
    const root = (index: number) => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    for (let i = 0; i < faces.length; i++) for (let j = 0; j < i; j++) {
      if (root(i) === root(j)) continue;
      const edge = sharedEdge(faces[i].points, faces[j].points);
      if (edge && !blocked(edge, faces[i].normal, blockers)) parents[root(i)] = root(j);
    }
    const patches = new Map<number, Face[]>();
    faces.forEach((face, i) => { const key = root(i), patch = patches.get(key) ?? []; patch.push(face); patches.set(key, patch); });
    for (const patch of patches.values()) {
      const first = patch[0], u = unit(subtract(first.points[1], first.points[0])), v = cross(first.normal, u);
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const face of patch) for (const point of face.points) [u, v].forEach((axis, k) => {
        const value = dot(point, axis); lo[k] = Math.min(lo[k], value); hi[k] = Math.max(hi[k], value);
      });
      charts.push({ faces: patch, u, v, lo, extent: hi.map((value, k) => value - lo[k]) });
    }
  }
  return charts;
}

export function chartCoordinates(chart: LightingChart, point: Point) {
  return [chart.u, chart.v].map((axis, k) => (dot(point, axis) - chart.lo[k]) / chart.extent[k]);
}
