import { Matrix, TransformNode, Vector3, type Mesh } from '@babylonjs/core';
import { generateLightingAtlas } from './lighting-atlas';
import type { AtlasGeometry } from './lighting-charts';

type Atlas = Awaited<ReturnType<typeof generateLightingAtlas>>;

async function atlasKey(geometry: AtlasGeometry[], furniture: boolean, size: number) {
  const bytes = new TextEncoder().encode(JSON.stringify([furniture, size, geometry]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
}

/** Caller-owned, bounded cache. Only completed unwraps are retained; transport is never cached here. */
export class LightingAtlasCache {
  private entries = new Map<string, Atlas>();

  clear() { this.entries.clear(); }

  async generate(geometry: AtlasGeometry[], furniture: boolean, size: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const key = await atlasKey(geometry, furniture, size);
    signal?.throwIfAborted();
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return { ...structuredClone(cached), reused: true };
    }
    const result = await generateLightingAtlas(geometry, new Set(furniture ? geometry.map((_, i) => i) : []),
      { size, maxSize: furniture ? 256 : size, signal });
    signal?.throwIfAborted();
    this.entries.set(key, result);
    // Also retain the successful starting size used by subsequent stable layouts.
    if (result.stats.size !== size) {
      this.entries.set(await atlasKey(geometry, furniture, result.stats.size), result);
    }
    while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    return { ...structuredClone(result), reused: false };
  }
}

/** Remove common rigid placement ancestors, retaining scale, reflections and part transforms. */
export function furnitureAtlasGeometry(meshes: Mesh[], fallback: AtlasGeometry[]): AtlasGeometry[] {
  if (!meshes.length) return fallback;
  const chains = meshes.map(mesh => {
    const chain: TransformNode[] = [];
    for (let node: TransformNode | null = mesh; node; node = node.parent as TransformNode | null) {
      if (!(node instanceof TransformNode) || node.billboardMode || node.infiniteDistance || node.isWorldMatrixFrozen) return [];
      node.computeWorldMatrix(true); chain.push(node);
    }
    return chain;
  });
  if (chains.some(chain => !chain.length)) return fallback;
  const common = chains[0].find(node => chains.every(chain => chain.includes(node)));
  if (!common) return fallback;
  let boundary: TransformNode | null = common;
  for (const node of chains[0].slice(chains[0].indexOf(common))) {
    if (!node.scaling.equalsToFloats(1, 1, 1) || node.scalingDeterminant !== 1 || node.isUsingPivotMatrix()) boundary = node.parent as TransformNode | null;
  }
  return meshes.map((mesh, i) => {
    let matrix = Matrix.Identity();
    for (const node of chains[i]) {
      if (node === boundary) break;
      matrix = matrix.multiply(node._localMatrix);
    }
    const normalMatrix = matrix.clone().invert().transpose();
    const source = mesh.getVerticesData('position')!, normals = mesh.getVerticesData('normal')!;
    const positions: number[] = [], transformedNormals: number[] = [];
    for (const index of mesh.getIndices()!) {
      positions.push(...Vector3.TransformCoordinates(Vector3.FromArray(source, index * 3), matrix).asArray());
      transformedNormals.push(...Vector3.TransformNormal(Vector3.FromArray(normals, index * 3), normalMatrix).normalize().asArray());
    }
    return { positions, normals: transformedNormals, transmitting: fallback[i].transmitting };
  });
}
