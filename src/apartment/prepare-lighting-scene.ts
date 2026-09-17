import { PBRMaterial, type Mesh, type WebGPUEngine } from '@babylonjs/core';
import type { SceneData } from '../comparison/main';
import { TRANSFER_SIZE } from '../comparison/transfer-data';
import { prepareTransfer } from '../comparison/prepare-transfer';
import { generateLightingAtlas } from './lighting-atlas';
import { prepareScene } from './prepare-scene';

export interface LightingSceneInput {
  /** Stable preparation meshes, in the same order used when loading the model. */
  meshes: Mesh[];
  /** Explicit ownership; the renderer does not depend on editor metadata. */
  furnitureMeshes: ReadonlySet<Mesh>;
  settings: Pick<SceneData, 'fixtures' | 'views' | 'sky'>;
  engine: WebGPUEngine;
  signal?: AbortSignal;
  onProgress?: (stage: 'scene' | 'atlas' | 'transfer', fraction: number) => void;
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
  const furniture = new Set(meshes.flatMap((mesh, i) => furnitureMeshes.has(mesh) ? [i] : []));
  const { atlas, stats: atlasStats } = await generateLightingAtlas(geometry, furniture, {
    size: TRANSFER_SIZE, signal, onProgress: fraction => onProgress('atlas', fraction),
  });
  sceneData.meshes.forEach((mesh, i) => { mesh.uvs = atlas[i]; });
  signal?.throwIfAborted(); onProgress('atlas', 1);
  const transfer = await prepareTransfer(sceneData, engine, fraction => onProgress('transfer', fraction), signal);
  signal?.throwIfAborted();
  return { atlas, sceneData, transferBytes: transfer.bytes,
    stats: { atlas: atlasStats, transfer: transfer.stats } };
}
