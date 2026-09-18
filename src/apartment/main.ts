import {
  Color3, Color4, Constants, DirectionalLight, Engine, Light,
  PointLight, Scene, ShadowGenerator, Texture, UniversalCamera, Vector3, WebGPUEngine,
} from '@babylonjs/core';
import { configureDisplay, createBloom } from '../graphics/display';
import { collectReflectionBoxes } from '../graphics/reflection-geometry';
import { loadApartment } from '../interior-lighting/apartment';
import { CachedTransfer } from '../comparison/cached-transfer';
import { lighting, skyDisplay, type SwitchMode } from '../comparison/lighting';
import { navigation } from '../comparison/navigation';
import type { SceneData } from '../comparison/main';
import { ApartmentLightmap, type ApartmentLightmapState } from './lightmap';
import { RoomReflections, type ReflectionRoom } from '../comparison/reflections';
import { apartmentReflectionRooms } from './reflection-rooms';
import '../comparison/style.css';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('scene'), status = element('status');
const time = element<HTMLInputElement>('time'), lights = element<HTMLSelectElement>('lights');
const bounces = element<HTMLSelectElement>('bounces'), view = element<HTMLSelectElement>('view');
const base = import.meta.env.BASE_URL;
const fixtureIntensityScale = .35;
const settings: Pick<SceneData, 'fixtures' | 'views' | 'sky'> = {
  sky: [.48, .65, 1],
  fixtures: [[10.2, 2.5, -6], [7.2, 2.5, -1.6], [1.6, 2.5, -6.7],
    [4.3, 2.5, -7.2], [7.2, 2.5, -7.2], [2.4, 2.5, -3.4], [4.6, 2.5, -3.4]]
    .map(position => ({ position: position as [number, number, number], color: [1, .72, .45], intensity: 90 / (4 * Math.PI) })),
  views: {
    living: { position: [10.5, 1.6, -4.8], target: [10.1, 1.4, -7.5], fov: 1.1 },
    hall: { position: [10.5, 1.6, -5], target: [5.3, 1.4, -4.4], fov: 1.1 },
    bedroom: { position: [6.3, 1.6, -6], target: [7.2, 1.4, -8.8], fov: 1.1 },
  },
};

async function start() {
  const preparing = new URLSearchParams(location.search).has('prepareTransfer');
  let engine: Engine | WebGPUEngine | undefined;
  if (await WebGPUEngine.IsSupportedAsync) {
    const gpu = new WebGPUEngine(canvas, { antialias: true, useExactSrgbConversions: true });
    try { await gpu.initAsync(); engine = gpu; }
    catch (error) { gpu.dispose(); console.warn('WebGPU unavailable; using baked WebGL lighting.', error); }
  }
  engine ??= new Engine(canvas, true, { useExactSrgbConversions: true });
  const activeEngine = engine, scene = new Scene(engine);
  scene.useRightHandedSystem = true; scene.collisionsEnabled = true;
  const display = configureDisplay(scene);
  const camera = new UniversalCamera('Apartment camera', Vector3.Zero(), scene);
  camera.inputs.clear(); camera.inertia = 0; camera.minZ = .05; camera.maxZ = 60;
  camera.checkCollisions = true; camera.ellipsoid.set(.18, .75, .18); camera.ellipsoidOffset.set(0, -.09, 0);
  const bloom = preparing ? undefined : createBloom(scene, camera);
  if (bloom) {
    for (const [id, property, digits] of [
      ['bloom-strength', 'bloomWeight', 2],
      ['bloom-threshold', 'bloomThreshold', 2],
      ['bloom-spread', 'bloomKernel', 0],
    ] as const) {
      const input = element<HTMLInputElement>(id);
      const update = () => {
        const value = Number(input.value);
        bloom[property] = value;
        element(id + '-value').textContent = value.toFixed(digits);
      };
      input.addEventListener('input', update);
      update();
    }
  }
  element('bloom-controls').hidden = preparing;
  let { meshes, materials } = await loadApartment(scene);
  const atlasResponse = await fetch(base + 'apartment-transfer/atlas.json');
  if (!atlasResponse.ok) throw Error('Apartment lighting atlas is missing.');
  const atlas: number[][] = await atlasResponse.json();
  meshes.forEach((mesh, index) => {
    mesh.convertToUnIndexedMesh();
    if (atlas[index]?.length !== mesh.getTotalVertices() * 2) throw Error('Apartment lighting atlas does not match the model.');
    mesh.setVerticesData('uv3', atlas[index]);
  });
  const reflectionBoxes = preparing ? [] : collectReflectionBoxes(meshes);
  let rooms: ReflectionRoom[] = [];
  if (!preparing) ({ meshes, materials, rooms } = apartmentReflectionRooms(meshes, materials));
  const baked = new Texture(base + 'models/bukit-merah/pbr/indirect.png', scene, false, false);
  baked.coordinatesIndex = 1; baked.gammaSpace = true; baked.level = 2;
  const basis: ApartmentLightmapState = { texture: baked, ready: false, sky: 1 };
  for (const material of materials) {
    material.maxSimultaneousLights = 8;
    material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
    if (material.needAlphaBlending()) continue;
    material.lightmapTexture = baked;
    new ApartmentLightmap(material, basis, true);
  }
  meshes.forEach(mesh => { mesh.checkCollisions = true; });
  const opaque = meshes.filter(mesh => !mesh.material!.needAlphaBlending());
  const sun = new DirectionalLight('Sun', new Vector3(0, -1, 0), scene);
  sun.shadowMinZ = .1; sun.shadowMaxZ = 50; sun.autoUpdateExtends = false; sun.shadowFrustumSize = 20;
  const sunShadow = new ShadowGenerator(2048, sun);
  sunShadow.usePercentageCloserFiltering = true; sunShadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  sunShadow.bias = .0005; sunShadow.normalBias = .005;
  opaque.forEach(mesh => sunShadow.addShadowCaster(mesh)); sunShadow.getShadowMap()!.refreshRate = 0;
  const fixtures = settings.fixtures.map((source, index) => {
    const light = new PointLight('Room light ' + (index + 1), new Vector3(...source.position), scene);
    light.diffuse = new Color3(...source.color); light.specular.copyFrom(light.diffuse);
    light.intensityMode = Light.INTENSITYMODE_LUMINOUSINTENSITY; light.falloffType = Light.FALLOFF_GLTF;
    light.shadowMinZ = .05; light.shadowMaxZ = 18;
    const shadow = new ShadowGenerator(1024, light);
    shadow.usePoissonSampling = true; shadow.bias = .004; shadow.normalBias = .002;
    opaque.forEach(mesh => shadow.addShadowCaster(mesh)); shadow.getShadowMap()!.refreshRate = 0;
    return light;
  });
  const reflections = new RoomReflections(scene, meshes, rooms, materials, reflectionBoxes);
  const reflectionControl = element<HTMLSelectElement>('reflections');
  if (preparing) { reflectionControl.value = 'off'; reflections.setEnabled(false); }
  reflectionControl.addEventListener('change', () => reflections.setEnabled(reflectionControl.value === 'on'));
  let transfer: CachedTransfer | undefined, loadError = '';
  function applyLighting() {
    const hour = Number(time.value), state = lighting(hour, lights.value as SwitchMode);
    transfer?.setLighting(state, settings.sky, Number(bounces.value));
    basis.sky = state.sky / 1.4;
    sun.direction.copyFromFloats(-state.direction[0], -state.direction[1], -state.direction[2]);
    sun.position.copyFrom(sun.direction.scale(-22).add(new Vector3(6.2, 1.4, -4.5)));
    sun.intensity = state.sun; sun.diffuse.set(state.color[0], state.color[1], state.color[2]); sun.specular.copyFrom(sun.diffuse);
    sunShadow.getShadowMap()!.resetRefreshCounter();
    fixtures.forEach((light, index) => { light.intensity = state.on ? settings.fixtures[index].intensity * fixtureIntensityScale : 0; });
    const sky = settings.sky.map(v => v * state.sky) as [number, number, number];
    scene.clearColor = new Color4(...(display.applyByPostProcess ? sky : skyDisplay(sky)), 1);
    const minutes = Math.round(hour * 60);
    element('time-label').textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  function resetView() {
    const selected = settings.views[view.value];
    camera.position.set(...selected.position); camera.setTarget(new Vector3(...selected.target)); camera.fov = selected.fov;
    camera.cameraDirection.setAll(0); camera.cameraRotation.setAll(0);
  }
  const updateStatus = () => {
    basis.ready = !!transfer?.ready && !transfer.error;
    bounces.disabled = !(engine instanceof WebGPUEngine) || !!loadError || !!transfer?.error;
    if (preparing) return;
    const on = lighting(Number(time.value), lights.value as SwitchMode).on;
    const label = loadError ? 'Cached diffuse unavailable · baked fallback' : transfer?.status || 'Baked skylight fallback';
    const text = `${engine instanceof WebGPUEngine ? 'WebGPU' : 'WebGL'} · Lights ${on ? 'on' : 'off'} (${lights.value}) · ${label} · ${reflections.status}`;
    if (status.textContent !== text) status.textContent = text;
  };
  time.addEventListener('input', applyLighting); lights.addEventListener('change', applyLighting);
  bounces.addEventListener('change', applyLighting); view.addEventListener('change', resetView);
  element('reset').addEventListener('click', resetView);
  document.querySelectorAll<HTMLButtonElement>('[data-hour]').forEach(button => button.addEventListener('click', () => {
    time.value = button.dataset.hour!; applyLighting();
  }));
  navigation(camera, canvas, () => {});
  const resize = () => activeEngine.resize();
  const observer = new ResizeObserver(resize); observer.observe(canvas); window.addEventListener('resize', resize);
  resetView(); applyLighting();
  await scene.whenReadyAsync();
  engine.runRenderLoop(() => {
    transfer?.tick(); updateStatus();
    const state = lighting(Number(time.value), lights.value as SwitchMode);
    const ready = !(engine instanceof WebGPUEngine) || !!loadError || !!transfer?.error || (!!transfer?.ready && !transfer.diagnostics().updating);
    reflections.tick(ready ? `${time.value}:${lights.value}:${bounces.value}:${transfer?.revision ?? 0}` : '',
      settings.sky.map(value => value * state.sky));
    scene.render();
  });
  const api = {
    scene, engine, camera, ready: true,
    state: () => ({ hour: Number(time.value), mode: lights.value, on: lighting(Number(time.value), lights.value as SwitchMode).on,
      activeGi: basis.ready ? 'transfer' : 'baked', bounces: Number(bounces.value), transfer: transfer?.diagnostics(),
      reflections: reflections.diagnostics(), loadError }),
  };
  Object.assign(window, { apartment: api, ...(preparing ? { comparison: api } : {}) });
  if (engine instanceof WebGPUEngine && preparing) {
    const gpu = engine;
    Object.assign(api, { prepareTransfer: async () => {
      status.textContent = 'Reading apartment materials…';
      const { prepareScene } = await import('./prepare-scene');
      const { prepareTransfer } = await import('../comparison/prepare-transfer');
      const sceneData = await prepareScene(meshes, materials, settings);
      status.textContent = 'Tracing apartment transfer…';
      const prepared = await prepareTransfer(sceneData, gpu, fraction => { status.textContent = `Preparing offline transfer · ${Math.round(fraction * 100)}%`; });
      return { ...prepared, sceneData };
    } });
  } else if (engine instanceof WebGPUEngine) {
    try {
      status.textContent = 'Loading apartment diffuse transfer…';
      const response = await fetch(base + 'apartment-transfer/scene.json');
      if (!response.ok) throw Error('Apartment diffuse data is missing.');
      const data: SceneData = await response.json();
      if (JSON.stringify(data.fixtures) !== JSON.stringify(settings.fixtures)) throw Error('Apartment lights changed. Regenerate the transfer cache.');
      transfer = new CachedTransfer(scene, engine, data, base + 'apartment-transfer/transfer.bin.gz', fixtureIntensityScale, true, true);
      basis.texture = transfer.texture; applyLighting();
    } catch (error) { loadError = String(error); console.warn(loadError); }
  }
  window.addEventListener('pagehide', () => { observer.disconnect(); bloom?.dispose(); reflections.dispose(); transfer?.dispose(); scene.dispose(); activeEngine.dispose(); }, { once: true });
}

start().catch(error => { console.error(error); status.textContent = String(error); });
