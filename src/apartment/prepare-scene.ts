import { Vector3, VertexBuffer, type Mesh, type PBRMaterial } from '@babylonjs/core';
import { albedoLayers } from '../interior-lighting/apartment';
import type { SceneData } from '../comparison/main';
import { metallicTextures } from './metallic-texture';

// An explicit atlas is in triangle-corner order; legacy callers still supply vertex uv3.
export async function prepareScene(meshes: Mesh[], materials: PBRMaterial[], settings: Pick<SceneData, 'fixtures' | 'views' | 'sky'>,
  lightingAtlas?: number[][]): Promise<SceneData> {
  const albedos = await albedoLayers(materials);
  const metallicMaps = await metallicTextures(materials);
  return {
    ...settings, sunHours: [], references: [], surfaceInset: .008,
    materials: materials.map((material, index) => ({ name: material.name,
      color: material.albedoColor.scale(metallicMaps[index] ? 1 : 1 - (material.metallic ?? 0)).asArray() as [number, number, number],
      roughness: material.roughness ?? 1, transmitting: material.needAlphaBlending(),
      ...(metallicMaps[index] ? { metallicTexture: metallicMaps[index] } : {}),
      ...(material.albedoTexture ? { diffuseTexture: { size: 128,
        pixels: Array.from(albedos.subarray(index * 128 * 128 * 4, (index + 1) * 128 * 128 * 4)) } } : {}),
    })),
    meshes: meshes.map((mesh, meshIndex) => {
      const world = mesh.computeWorldMatrix(true), normalMatrix = world.clone().invert().transpose();
      const source = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const normal = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const uv = mesh.getVerticesData(VertexBuffer.UVKind)!;
      const atlas = lightingAtlas ? lightingAtlas[meshIndex] : mesh.getVerticesData(VertexBuffer.UV3Kind);
      if (!atlas) throw Error('Apartment mesh has no lightmap UVs: ' + mesh.name);
      const sourceIndices = Array.from(mesh.getIndices()!);
      const order = lightingAtlas ? sourceIndices : Array.from({ length: source.length / 3 }, (_, i) => i);
      if (atlas.length !== order.length * 2) throw Error('Lighting atlas does not match mesh: ' + mesh.name);
      const material = mesh.material as PBRMaterial, textureMatrix = material.albedoTexture?.getTextureMatrix();
      const metallicTexture = metallicMaps[materials.indexOf(material)] ? material.metallicTexture : null;
      const metallicSource = metallicTexture ? mesh.getVerticesData(metallicTexture.coordinatesIndex === 0 ? 'uv' : 'uv' + (metallicTexture.coordinatesIndex + 1)) : null;
      if (metallicTexture && !metallicSource) throw Error('Missing metallic texture UVs: ' + mesh.name);
      const metallicMatrix = metallicTexture?.getTextureMatrix(), metallicUvs: number[] = [];
      const positions: number[] = [], normals: number[] = [], albedoUvs: number[] = [];
      for (const i of order) {
        positions.push(...Vector3.TransformCoordinates(Vector3.FromArray(source, i * 3), world).asArray());
        normals.push(...Vector3.TransformNormal(Vector3.FromArray(normal, i * 3), normalMatrix).normalize().asArray());
        const coord = new Vector3(uv?.[i * 2] ?? 0, uv?.[i * 2 + 1] ?? 0, 1);
        if (textureMatrix) Vector3.TransformCoordinatesToRef(coord, textureMatrix, coord);
        albedoUvs.push(coord.x, coord.y);
        if (metallicSource && metallicMatrix) {
          const metallicCoord = Vector3.TransformCoordinates(new Vector3(metallicSource[i * 2], metallicSource[i * 2 + 1], 1), metallicMatrix);
          metallicUvs.push(metallicCoord.x, metallicCoord.y);
        }
      }
      const indices = lightingAtlas ? order.map((_, i) => i) : sourceIndices;
      if (world.determinant() < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      return { material: materials.indexOf(material), positions, normals, uvs: Array.from(atlas), albedoUvs, indices,
        ...(metallicTexture ? { metallicUvs } : {}) };
    }),
  };
}
