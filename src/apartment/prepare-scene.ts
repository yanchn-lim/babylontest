import { Vector3, VertexBuffer, type Mesh, type PBRMaterial } from '@babylonjs/core';
import { albedoLayers } from '../interior-lighting/apartment';
import type { SceneData } from '../comparison/main';

export async function prepareScene(meshes: Mesh[], materials: PBRMaterial[], settings: Pick<SceneData, 'fixtures' | 'views' | 'sky'>): Promise<SceneData> {
  const albedos = await albedoLayers(materials);
  return {
    ...settings, sunHours: [], references: [], surfaceInset: .008,
    materials: materials.map((material, index) => ({ name: material.name,
      color: material.albedoColor.scale(1 - (material.metallic ?? 0)).asArray() as [number, number, number],
      roughness: material.roughness ?? 1, transmitting: material.needAlphaBlending(),
      ...(material.albedoTexture ? { diffuseTexture: { size: 128,
        pixels: Array.from(albedos.subarray(index * 128 * 128 * 4, (index + 1) * 128 * 128 * 4)) } } : {}),
    })),
    meshes: meshes.map(mesh => {
      const world = mesh.computeWorldMatrix(true), normalMatrix = world.clone().invert().transpose();
      const source = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const normal = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const uv = mesh.getVerticesData(VertexBuffer.UVKind)!;
      const atlas = mesh.getVerticesData(VertexBuffer.UV3Kind);
      if (!atlas) throw Error('Apartment mesh has no lightmap UVs: ' + mesh.name);
      const material = mesh.material as PBRMaterial, textureMatrix = material.albedoTexture?.getTextureMatrix();
      const positions: number[] = [], normals: number[] = [], albedoUvs: number[] = [];
      for (let i = 0; i < source.length / 3; i++) {
        positions.push(...Vector3.TransformCoordinates(Vector3.FromArray(source, i * 3), world).asArray());
        normals.push(...Vector3.TransformNormal(Vector3.FromArray(normal, i * 3), normalMatrix).normalize().asArray());
        const coord = new Vector3(uv[i * 2], uv[i * 2 + 1], 1);
        if (textureMatrix) Vector3.TransformCoordinatesToRef(coord, textureMatrix, coord);
        albedoUvs.push(coord.x, coord.y);
      }
      const indices = Array.from(mesh.getIndices()!);
      if (world.determinant() < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      return { material: materials.indexOf(material), positions, normals, uvs: Array.from(atlas), albedoUvs, indices };
    }),
  };
}
