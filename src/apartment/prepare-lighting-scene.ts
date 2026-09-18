import { PBRMaterial, type Mesh, type WebGPUEngine } from '@babylonjs/core';
import type { SceneData } from '../comparison/main';
import { prepareTransfer } from '../comparison/prepare-transfer';
import type { TransferPreparationOptions } from '../comparison/preparation-schedule';
import { generateLightingPages } from './lighting-pages';
import type { LightingLayout } from '../comparison/transfer-layout';
import { prepareScene } from './prepare-scene';
import { lightingIndices } from './lighting-geometry';
import { LightingAtlasCache, furnitureAtlasGeometry } from './lighting-atlas-cache';
export { LightingAtlasCache } from './lighting-atlas-cache';

export interface LightingSceneInput {
  /** Stable preparation meshes, in the same order used when loading the model. */
  meshes: Mesh[];
  /** Explicit ownership; the renderer does not depend on editor metadata. */
  furnitureMeshes: ReadonlySet<Mesh>;
  /** Stable instance IDs; each group owns a separate lighting allocation. */
  furnitureGroups?: ReadonlyMap<string, ReadonlySet<Mesh>>;
  previousLayout?: LightingLayout;
  /** Retain in the preparation worker to reuse completed unwraps between builds. */
  atlasCache?: LightingAtlasCache;
  settings: Pick<SceneData, 'fixtures' | 'views' | 'sky'>;
  engine: WebGPUEngine;
  signal?: AbortSignal;
  transferOptions?: TransferPreparationOptions;
  onProgress?: (stage: 'scene' | 'atlas' | 'transfer', fraction: number) => void;
  onAtlasReady?: (atlas: number[][], sceneData: SceneData) => void;
}

/** Prepare one matching atlas, scene description and raw transfer cache. No input mesh is modified. */
export async function prepareLightingScene(input: LightingSceneInput) {
  const { meshes, furnitureMeshes, engine, signal, onProgress = () => {} } = input;
  signal?.throwIfAborted();
  if (!engine.isWebGPU) throw Error('Lighting preparation requires WebGPU.');
  if (!meshes.length || new Set(meshes).size !== meshes.length || [...furnitureMeshes].some(mesh => !meshes.includes(mesh))) throw Error('Invalid lighting mesh list.');
  const settings = structuredClone(input.settings);
  const vector = (value: number[]) => value?.length === 3 && value.every(Number.isFinite);
  if (!vector(settings.sky) || settings.sky.some(v => v < 0) || settings.fixtures.length < 1 || settings.fixtures.length > 8
    || settings.fixtures.some(light => !vector(light.position) || !vector(light.color) || light.color.some(v => v < 0)
      || !Number.isFinite(light.intensity) || light.intensity < 0)) throw Error('Lighting preparation requires a sky colour and one to eight valid fixed lights.');
  const emptyAtlas = meshes.map(mesh => {
    const positions = mesh.getVerticesData('position'), normals = mesh.getVerticesData('normal'), indices = mesh.getIndices();
    const world = mesh.computeWorldMatrix(true);
    if (!(mesh.material instanceof PBRMaterial) || !positions?.length || positions.length % 3 || normals?.length !== positions.length
      || !indices?.length || indices.length % 3 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= positions.length / 3)
      || !Number.isFinite(world.determinant()) || Math.abs(world.determinant()) < 1e-12) throw Error('Invalid lighting mesh: ' + mesh.name);
    if (mesh.material.albedoTexture && !mesh.getVerticesData('uv')) throw Error('Missing material texture coordinates: ' + mesh.name);
    if (mesh.skeleton || mesh.morphTargetManager || mesh.hasThinInstances) throw Error('Lighting preparation requires static meshes: ' + mesh.name);
    return new Array<number>(indices.length * 2).fill(0);
  });
  const materials = [...new Set(meshes.map(mesh => mesh.material as PBRMaterial))];
  onProgress('scene', 0);
  const sceneData = await prepareScene(meshes, materials, settings, emptyAtlas);
  signal?.throwIfAborted(); onProgress('scene', 1);
  const geometry = sceneData.meshes.map(mesh => ({ positions: mesh.positions, normals: mesh.normals,
    transmitting: !!sceneData.materials[mesh.material].transmitting }));
  const groups = new Map<string, number[]>();
  if (input.furnitureGroups) {
    const assigned = new Set<Mesh>();
    for (const [id, members] of input.furnitureGroups) {
      for (const mesh of members) {
        if (!furnitureMeshes.has(mesh) || assigned.has(mesh)) throw Error('Invalid furniture allocation ownership.');
        assigned.add(mesh);
      }
      groups.set(id, [...members].map(mesh => meshes.indexOf(mesh)));
    }
    if (assigned.size !== furnitureMeshes.size) throw Error('Furniture allocation groups must cover every furniture mesh.');
  } else {
    meshes.forEach((mesh, i) => { if (furnitureMeshes.has(mesh)) groups.set('mesh-' + i, [i]); });
  }
  onProgress('atlas', 0);
  const furnitureGeometry = new Map([...groups].map(([id, indices]) => [id,
    furnitureAtlasGeometry(indices.map(i => meshes[i]), indices.map(i => geometry[i]))]));
  const { atlas, layout, stats: atlasStats } = await generateLightingPages(geometry, groups, {
    previousLayout: input.previousLayout, atlasCache: input.atlasCache, furnitureGeometry,
    signal, onProgress: fraction => onProgress('atlas', fraction),
  });
  sceneData.lightingLayout = layout;
  sceneData.meshes.forEach((mesh, i) => {
    mesh.uvs = atlas[i];
    mesh.indices = lightingIndices(mesh.positions, mesh.indices);
  });
  signal?.throwIfAborted(); onProgress('atlas', 1);
  input.onAtlasReady?.(atlas, sceneData);
  onProgress('transfer', 0);
  const transfer = await prepareTransfer(sceneData, engine, fraction => onProgress('transfer', fraction), signal,
    { batchSize: 1024, pauseMilliseconds: 8, ...input.transferOptions });
  signal?.throwIfAborted();
  return { atlas, sceneData, transferBytes: transfer.bytes,
    stats: { atlas: atlasStats, transfer: transfer.stats } };
}
