import { Mesh, PBRMaterial, Vector3, type AbstractMesh } from '@babylonjs/core';
import { localReflectionBoxes, type ReflectionBox } from './reflection-boxes';

/** Read actual world-space triangles; never substitute a mesh's loose bounds. */
export function collectReflectionBoxes(meshes: Mesh[]) {
  const materials = meshes.map(mesh => ({ transmitting: !(mesh.material instanceof PBRMaterial) || mesh.material.needAlphaBlending() }));
  const geometry = meshes.map((mesh, material) => {
    const source = mesh.getVerticesData('position')!, world = mesh.computeWorldMatrix(true);
    const positions: number[] = [];
    for (let i = 0; i < source.length; i += 3) positions.push(...Vector3.TransformCoordinates(Vector3.FromArray(source, i), world).asArray());
    return { positions, indices: Array.from(mesh.getIndices() ?? []), material };
  });
  return localReflectionBoxes({ meshes: geometry, materials });
}

/** Bound the per-pixel cost and cache selection until the geometry revision changes. */
export function reflectionBoxLookup(boxes: ReflectionBox[]) {
  const selected = new WeakMap<AbstractMesh, ReflectionBox[]>();
  return (mesh: AbstractMesh) => {
    let result = selected.get(mesh);
    if (!result) {
      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      const lo = bounds.minimumWorld.asArray(), hi = bounds.maximumWorld.asArray();
      result = boxes.map(box => ({ box, distance: Math.hypot(...box.min.map((v, k) => Math.max(0, v - hi[k], lo[k] - box.max[k]))) }))
        .filter(item => item.distance <= 1.5).sort((a, b) => a.distance - b.distance).slice(0, 8).map(item => item.box);
      selected.set(mesh, result);
    }
    return result;
  };
}
