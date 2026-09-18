import { Color3, Constants, DirectionalLight, ImageProcessingConfiguration, Light, PBRMaterial, PointLight,
  RawTexture, Scene, ShadowGenerator, UniversalCamera, Vector3, WebGPUEngine } from '@babylonjs/core';
import { ApartmentLightmap } from '../apartment/lightmap';
import { CachedTransfer } from '../comparison/cached-transfer';
import { lighting } from '../comparison/lighting';
import { navigation } from '../comparison/navigation';
import { loadFixture, type Placement } from './fixture';
import type { Layout } from './furnishings';
import type { SceneData } from '../comparison/main';

export async function createPreview(canvas: HTMLCanvasElement, base: string, status: HTMLElement) {
  if (!await WebGPUEngine.IsSupportedAsync) throw Error('This preparation lab requires WebGPU.');
  const engine = new WebGPUEngine(canvas, { antialias: true, useExactSrgbConversions: true });
  await engine.initAsync();
  const scene = new Scene(engine); scene.useRightHandedSystem = true; scene.collisionsEnabled = true;
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1 / .6;
  const fixture = await loadFixture(scene, base, false);
  let selected = fixture.select('single', 'original');
  const camera = new UniversalCamera('Lab camera', Vector3.Zero(), scene);
  camera.inputs.clear(); camera.inertia = 0; camera.minZ = .05; camera.maxZ = 60;
  camera.checkCollisions = true; camera.ellipsoid.set(.18, .75, .18); camera.ellipsoidOffset.set(0, -.09, 0);
  const resetCamera = () => {
    const view = fixture.settings.views.living;
    camera.position.set(...view.position); camera.setTarget(new Vector3(...view.target)); camera.fov = view.fov;
    camera.cameraDirection.setAll(0); camera.cameraRotation.setAll(0);
  };
  resetCamera(); navigation(camera, canvas, () => {});
  const black = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false);
  black.gammaSpace = false;
  const basis = { texture: black, ready: false, sky: 0 };
  for (const mesh of fixture.meshes) {
    mesh.makeGeometryUnique();
    mesh.convertToUnIndexedMesh(); mesh.setVerticesData('uv3', new Float32Array(mesh.getTotalVertices() * 2));
    mesh.checkCollisions = true; mesh.receiveShadows = true;
  }
  for (const material of new Set(fixture.meshes.map(mesh => mesh.material as PBRMaterial))) {
    material.maxSimultaneousLights = 8; material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
    if (material.needAlphaBlending()) continue;
    material.lightmapTexture = black; new ApartmentLightmap(material, basis, true);
  }
  const state = lighting(9, 'on'), shadows: ShadowGenerator[] = [];
  const sun = new DirectionalLight('Sun', new Vector3(...state.direction.map(v => -v)), scene);
  sun.position.copyFrom(sun.direction.scale(-22).add(new Vector3(6.2, 1.4, -4.5)));
  sun.intensity = state.sun; sun.diffuse = new Color3(...state.color); sun.specular.copyFrom(sun.diffuse);
  sun.shadowMinZ = .1; sun.shadowMaxZ = 50; sun.shadowFrustumSize = 20;
  const addShadow = (light: DirectionalLight | PointLight, size: number) => {
    const shadow = new ShadowGenerator(size, light); shadow.usePoissonSampling = true;
    shadow.bias = .001; shadow.normalBias = .003;
    fixture.meshes.filter(mesh => !mesh.material!.needAlphaBlending()).forEach(mesh => shadow.addShadowCaster(mesh));
    shadow.getShadowMap()!.refreshRate = 0; shadows.push(shadow);
  };
  addShadow(sun, 1024);
  fixture.settings.fixtures.forEach(source => {
    const light = new PointLight('Room light', new Vector3(...source.position), scene);
    light.diffuse = new Color3(...source.color); light.specular.copyFrom(light.diffuse);
    light.intensityMode = Light.INTENSITYMODE_LUMINOUSINTENSITY; light.falloffType = Light.FALLOFF_GLTF;
    light.intensity = source.intensity * .35; light.shadowMinZ = .05; light.shadowMaxZ = 18; addShadow(light, 512);
  });
  let transfer: CachedTransfer | undefined, cacheUrl: string | undefined;
  const clear = () => {
    basis.ready = false; basis.texture = black; transfer?.dispose(); transfer = undefined;
    if (cacheUrl) URL.revokeObjectURL(cacheUrl); cacheUrl = undefined;
  };
  const render = () => {
    transfer?.tick(); basis.ready = !!transfer?.ready && !transfer.error;
    const cache = transfer?.diagnostics();
    status.textContent = transfer ? (transfer.error || (basis.ready
      ? `Fresh GI · 4 bounces · ${cache!.transferPages} cache pages · ${(cache!.transferBytes / 2 ** 20).toFixed(1)} MiB entries · ${(cache!.largestTransferPageBytes / 2 ** 20).toFixed(1)} MiB largest page`
      : 'Applying fresh GI…')) : 'Direct light · GI not built';
    scene.render();
  };
  const place = (layout: Layout, placement: Placement) => {
    clear(); selected = fixture.select(layout, placement); shadows.forEach(shadow => shadow.getShadowMap()!.resetRefreshCounter());
    return selected.counts;
  };
  place('single', 'original'); engine.runRenderLoop(render);
  window.addEventListener('resize', () => engine.resize());
  return { place, resetCamera,
    pause(paused: boolean) { if (paused) engine.stopRenderLoop(render); else engine.runRenderLoop(render); },
    apply(atlas: number[][], data: SceneData, gzip: Uint8Array) {
      if (atlas.length !== selected.meshes.length || atlas.some((uv, i) => uv.length !== selected.meshes[i].getTotalVertices() * 2)) throw Error('Prepared atlas does not match preview meshes.');
      clear(); selected.meshes.forEach((mesh, i) => mesh.setVerticesData('uv3', atlas[i]));
      cacheUrl = URL.createObjectURL(new Blob([new Uint8Array(gzip)]));
      transfer = new CachedTransfer(scene, engine, data, cacheUrl, .35, true, true);
      basis.texture = transfer.texture; transfer.setLighting(state, fixture.settings.sky, 4);
    },
  };
}
