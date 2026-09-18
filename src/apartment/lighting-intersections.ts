import { PBRMaterial, type Mesh } from '@babylonjs/core';
import { partitionSurfaceMeshes } from '../interior-lighting/surface-partition';

/** Split architecture at intersections before generating its lighting charts.
 * Call once on matching preparation and display meshes. Furniture is excluded by the caller.
 * Surface positions and interpolated material attributes are preserved; topology changes.
 */
export function partitionLightingArchitecture(meshes: Mesh[]) {
  const opaque = meshes.filter(mesh =>
    mesh.material instanceof PBRMaterial && !mesh.material.needAlphaBlending());
  return partitionSurfaceMeshes(opaque);
}
