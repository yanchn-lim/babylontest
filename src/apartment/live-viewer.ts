import { Color3, Color4, Constants, DirectionalLight, Light, PBRMaterial, PointLight,
  Scene, ShadowGenerator, UniversalCamera, Vector3, WebGPUEngine, type Mesh } from '@babylonjs/core';
import { configureDisplay, createBloom } from '../graphics/display';
import { LiveReflections, type ReflectionRegion } from '../graphics/live-reflections';
import { ApartmentLightmap } from './lightmap';
import { LiveLighting, type LiveLightingResult, type LiveLightingStream } from './live-lighting';
import type { TransferCheckpoint } from '../comparison/transfer-checkpoint';
import type { LightingPreviewChunk } from '../comparison/streaming-preview';
import { lighting } from '../comparison/lighting';
import { navigation } from '../comparison/navigation';
import type { SceneData } from '../comparison/main';

export interface LiveViewerInput {
  meshes: Mesh[];
  settings: Pick<SceneData, 'fixtures' | 'sky' | 'views'> & { reflectionRooms?: ReflectionRegion[] };
}

/** Direct-light apartment viewer; loadScene supplies native materials and geometry. */
export async function createLiveViewer(canvas: HTMLCanvasElement, loadScene: (scene: Scene) => Promise<LiveViewerInput>,
  callbacks: { onReady?: (revision: number) => void; onStatus?: (text: string) => void } = {}) {
  if (!await WebGPUEngine.IsSupportedAsync) throw Error('The live lighting viewer requires WebGPU.');
  const engine = new WebGPUEngine(canvas, { antialias: true, useExactSrgbConversions: true });
  try { await engine.initAsync(); } catch (error) { engine.dispose(); throw error; }
  const scene = new Scene(engine); scene.useRightHandedSystem = true; scene.collisionsEnabled = true;
  configureDisplay(scene);
  let input: LiveViewerInput;
  try { input = await loadScene(scene); } catch (error) { scene.dispose(); engine.dispose(); throw error; }
  const { settings } = input;
  const camera = new UniversalCamera('Apartment camera', Vector3.Zero(), scene);
  const bloom = createBloom(scene, camera), reflections = new LiveReflections(scene);
  camera.inputs.clear(); camera.inertia = 0; camera.minZ = .05; camera.maxZ = 60;
  camera.checkCollisions = true; camera.ellipsoid.set(.18, .75, .18); camera.ellipsoidOffset.set(0, -.09, 0);
  const resetCamera = () => {
    const view = settings.views.living ?? Object.values(settings.views)[0];
    if (!view) { camera.position.set(10.5, 1.6, -4.8); camera.setTarget(new Vector3(10.1, 1.4, -7.5)); return; }
    camera.position.set(...view.position); camera.setTarget(new Vector3(...view.target)); camera.fov = view.fov;
    camera.cameraDirection.setAll(0); camera.cameraRotation.setAll(0);
  };
  resetCamera(); navigation(camera, canvas, () => {});
  const live = new LiveLighting(scene, engine, callbacks.onReady), basis = live.basis;
  const initialized = new WeakSet<Mesh>(), initializedMaterials = new WeakSet<PBRMaterial>();
  const initialize = (meshes: Mesh[]) => {
    for (const mesh of meshes) {
      if (initialized.has(mesh)) continue; initialized.add(mesh);
      mesh.makeGeometryUnique();
      mesh.convertToUnIndexedMesh(); mesh.setVerticesData('uv3', new Float32Array(mesh.getTotalVertices() * 2));
      mesh.checkCollisions = true; mesh.receiveShadows = true;
    }
    for (const material of new Set(meshes.map(mesh => mesh.material as PBRMaterial))) {
      if (initializedMaterials.has(material)) continue; initializedMaterials.add(material);
      material.maxSimultaneousLights = 8; material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
      if (material.needAlphaBlending()) continue;
      material.lightmapTexture = basis.texture; new ApartmentLightmap(material, basis, true);
    }
  };
  reflections.reset(input.meshes, settings.reflectionRooms);
  initialize(input.meshes);
  const state = lighting(9, 'on'), shadows: ShadowGenerator[] = [];
  const sun = new DirectionalLight('Sun', new Vector3(...state.direction.map(v => -v)), scene);
  sun.position.copyFrom(sun.direction.scale(-22).add(new Vector3(6.2, 1.4, -4.5)));
  sun.intensity = state.sun; sun.diffuse = new Color3(...state.color); sun.specular.copyFrom(sun.diffuse);
  sun.shadowMinZ = .1; sun.shadowMaxZ = 50; sun.autoUpdateExtends = false; sun.shadowFrustumSize = 20;
  const addShadow = (light: DirectionalLight | PointLight, size: number) => {
    const shadow = new ShadowGenerator(size, light);
    if (light === sun) {
      shadow.usePercentageCloserFiltering = true; shadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
      shadow.bias = .0005; shadow.normalBias = .005;
    } else {
      shadow.usePoissonSampling = true; shadow.bias = .004; shadow.normalBias = .002;
    }
    input.meshes.filter(mesh => !mesh.material!.needAlphaBlending()).forEach(mesh => shadow.addShadowCaster(mesh));
    shadow.getShadowMap()!.refreshRate = 0; shadows.push(shadow);
  };
  addShadow(sun, 2048);
  settings.fixtures.forEach(source => {
    const light = new PointLight('Room light', new Vector3(...source.position), scene);
    light.diffuse = new Color3(...source.color); light.specular.copyFrom(light.diffuse);
    light.intensityMode = Light.INTENSITYMODE_LUMINOUSINTENSITY; light.falloffType = Light.FALLOFF_GLTF;
    light.intensity = source.intensity * .35; light.shadowMinZ = .05; light.shadowMaxZ = 18; addShadow(light, 1024);
  });
  live.setLighting(state, settings.sky);
  scene.clearColor = new Color4(...settings.sky.map(v => v * state.sky) as [number, number, number], 1);
  let frames = 0;
  const render = () => {
    live.tick();
    const info = live.diagnostics(), cache = info.transfer;
    const text = info.error ? 'Direct light · ' + info.error : info.phase === 'ready'
      ? `Fresh GI · 4 bounces · ${cache!.transferPages} cache pages · ${(cache!.transferBytes / 2 ** 20).toFixed(1)} MiB entries`
      : info.phase === 'refining' ? cache?.ready ? `${cache.checkpointRays}-ray GI · 4 bounces · Refining lighting`
        : `Streaming provisional GI · Preparing full lighting · ${info.streamUpdates} updates`
      : info.phase === 'installing' ? `${basis.ready ? 'Provisional GI' : 'Direct light'} · Installing GI · ${(info.uploadedBytes / 2 ** 20).toFixed(1)} MiB uploaded`
      : info.phase === 'streaming' ? `Streaming provisional GI · ${Math.round(info.streamFraction * 100)}% · ${info.streamUpdates} updates`
      : 'Direct light · Ready to explore';
    callbacks.onStatus?.(text);
    const reflectionKey = info.revision < 0 ? '' : info.phase === 'ready' ? `${info.revision}:gi:${cache?.revision}`
      : info.phase === 'preview' ? `${info.revision}:direct` : '';
    reflections.tick(reflectionKey, settings.sky.map(value => value * state.sky));
    scene.render(); frames++;
  };
  const reset = (revision: number, meshes: Mesh[]) => {
    live.reset(revision, meshes);
    reflections.reset(meshes, settings.reflectionRooms); initialize(meshes);
    for (const shadow of shadows) {
      shadow.getShadowMap()!.renderList = meshes.filter(mesh => !mesh.material!.needAlphaBlending());
      shadow.getShadowMap()!.resetRefreshCounter();
    }
  };
  await scene.whenReadyAsync();
  const firstFrame = new Promise<void>(resolve => { scene.onAfterRenderObservable.addOnce(() => resolve()); });
  engine.runRenderLoop(render);
  await firstFrame;
  const resize = () => engine.resize();
  window.addEventListener('resize', resize);
  return { scene, engine, camera, reset, resetCamera,
    beginStream(snapshot: LiveLightingStream) {
      if (snapshot.revision !== live.diagnostics().revision) return false;
      if (JSON.stringify(snapshot.sceneData.fixtures) !== JSON.stringify(settings.fixtures)) throw Error('Lighting fixtures do not match the viewer.');
      return live.beginStream(snapshot);
    },
    updateStream: (chunk: LightingPreviewChunk & { revision: number }) => live.updateStream(chunk),
    cancelStream: (revision: number) => live.cancelStream(revision),
    pause(paused: boolean) { if (paused) engine.stopRenderLoop(render); else engine.runRenderLoop(render); },
    applyCheckpoint(checkpoint: TransferCheckpoint & { revision: number }) { return live.applyCheckpoint(checkpoint); },
    apply(result: LiveLightingResult) {
      if (result.revision !== live.diagnostics().revision) return false;
      if (JSON.stringify(result.sceneData.fixtures) !== JSON.stringify(settings.fixtures)) throw Error('Lighting fixtures do not match the viewer.');
      return live.apply(result);
    },
    dispose() { window.removeEventListener('resize', resize); engine.stopRenderLoop(render); live.dispose(); reflections.dispose(); bloom.dispose(); scene.dispose(); engine.dispose(); },
    diagnostics: () => ({ ...live.diagnostics(), frames, camera: camera.position.asArray(), reflections: reflections.diagnostics(), dithering: scene.imageProcessingConfiguration.ditheringEnabled }),
  };
}
