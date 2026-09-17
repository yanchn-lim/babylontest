import { Mesh, PBRMaterial, SceneLoader, type Scene } from '@babylonjs/core';
import type { SceneData } from './main';

export async function loadCouch(scene: Scene) {
  await import('@babylonjs/loaders/glTF');
  const asset = await SceneLoader.ImportMeshAsync('', import.meta.env.BASE_URL + 'comparison/couch/', 'klippan.glb', scene);
  const meshes = asset.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
  // Flatten the imported transforms identically during preparation and display.
  for (const mesh of meshes) {
    const world = mesh.computeWorldMatrix(true).clone();
    mesh.parent = null;
    mesh.bakeTransformIntoVertices(world);
    mesh.position.set(0, 0, -1);
    mesh.scaling.setAll(1); mesh.rotationQuaternion = null; mesh.rotation.setAll(0);
    mesh.convertToUnIndexedMesh();
    mesh.receiveShadows = true; mesh.checkCollisions = true;
  }
  return { meshes, materials: [...new Set(meshes.map(mesh => mesh.material as PBRMaterial))] };
}

export function couchMaterialMode(data: SceneData, corrected: boolean) {
  const result = structuredClone(data);
  if (!corrected) for (const material of result.materials) {
    if (!material.metallicTexture) continue;
    material.color = material.color.map(value => value * (1 - material.metallicTexture!.factor)) as [number, number, number];
    delete material.metallicTexture;
  }
  return result;
}
