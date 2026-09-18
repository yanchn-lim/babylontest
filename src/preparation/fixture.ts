import { Mesh, PBRMaterial, TransformNode, type Scene } from '@babylonjs/core';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { apartmentReflectionLayout } from '../apartment/reflection-rooms';
import { partitionLightingArchitecture } from '../apartment/lighting-intersections';
import type { SceneData } from '../comparison/main';
import { createFurnishings, layoutLabels, type Layout } from './furnishings';

export const placements = {
  original: { position: [10, 0, -7], rotation: 0 },
  moved: { position: [9.4, 0, -7], rotation: 0 },
  rotated: { position: [10, 0, -7], rotation: Math.PI / 2 },
  rotated30: { position: [10, 0, -7], rotation: Math.PI / 6 },
  rotated135: { position: [10, 0, -7], rotation: Math.PI * 3 / 4 },
} as const;
export type Placement = keyof typeof placements;

export async function loadFixture(scene: Scene, base: string, preparation: boolean) {
  const options = preparation ? { pluginOptions: { gltf: { useSRGBBuffers: false } } } : {};
  const modelUrl = new URL('models/bukit-merah/pbr/Apartment.gltf', base);
  const response = await fetch(modelUrl);
  if (!response.ok) throw Error('Could not load the apartment.');
  const model = await response.json();
  for (const asset of [...model.buffers, ...model.images]) if (asset.uri) asset.uri = new URL(asset.uri, modelUrl).href;
  const apartment = await ImportMeshAsync('data:' + JSON.stringify(model), scene, { ...options, pluginExtension: '.gltf' });
  const sofa = await ImportMeshAsync(new URL('comparison/applaryd/applaryd.glb', base).href, scene, options);
  const root = new TransformNode('Sofa placement', scene);
  for (const node of sofa.meshes) if (!node.parent) node.parent = root;
  const eligible = (mesh: unknown): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0 && mesh.material instanceof PBRMaterial;
  const apartmentMeshes = apartment.meshes.filter(eligible), sofaMeshes = sofa.meshes.filter(eligible);
  partitionLightingArchitecture(apartmentMeshes);
  const sofaRoots = [root];
  const copies = [[root, sofaMeshes]] as [TransformNode, Mesh[]][];
  for (const [index, x] of [1.5, 4.5].entries()) {
    const copy = root.clone('Sofa copy ' + (index + 1), null)!;
    copy.position.set(x, 0, -6.7); copy.setEnabled(false); sofaRoots.push(copy);
    copies.push([copy, copy.getChildMeshes().filter(eligible)]);
  }
  const simple = await createFurnishings(scene, base, preparation);
  const meshes = [...apartmentMeshes, ...copies.flatMap(([, meshes]) => meshes), ...simple.meshes];
  const settingsResponse = await fetch(new URL('apartment-transfer/scene.json', base));
  if (!settingsResponse.ok) throw Error('Could not load lighting settings.');
  const { fixtures, sky, views } = await settingsResponse.json() as SceneData;
  const settings = { fixtures, sky, views, reflectionRooms: apartmentReflectionLayout() };
  return { meshes, settings,
    select(layout: Layout, placement: Placement) {
      if (!Object.hasOwn(layoutLabels, layout)) throw Error('Unknown benchmark layout.');
      placeSofa(root, placement);
      const count = layout === 'three' ? 3 : layout === 'two' ? 2 : 1;
      sofaRoots.forEach((root, i) => root.setEnabled(i < count));
      simple.roots.forEach(root => root.setEnabled(layout === 'furnished'));
      const activeFurniture = [...copies.slice(0, count).flatMap(([, meshes]) => meshes), ...(layout === 'furnished' ? simple.meshes : [])];
      const active = [...apartmentMeshes, ...activeFurniture];
      const furnitureGroups = new Map(copies.slice(0, count).map(([, meshes], i) => ['sofa-' + i, new Set(meshes)]));
      if (layout === 'furnished') simple.roots.forEach((root, i) => furnitureGroups.set('ikea-' + i, new Set(root.getChildMeshes().filter(eligible))));
      return { meshes: active, furnitureMeshes: new Set(activeFurniture), furnitureGroups, settings,
        counts: { objects: count + (layout === 'furnished' ? simple.roots.length : 0), meshes: active.length,
          triangles: active.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0) } };
    },
  };
}

export function placeSofa(root: TransformNode, placement: Placement) {
  const pose = placements[placement];
  if (!pose) throw Error('Unknown sofa placement.');
  root.position.set(pose.position[0], pose.position[1], pose.position[2]); root.rotation.y = pose.rotation;
}
