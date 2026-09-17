import {
  Color3, Color4, Constants, DirectionalLight, Engine, ImageProcessingConfiguration,
  Light, Material, Mesh, PBRMaterial, PointLight, RawTexture, Scene, ShadowGenerator, Texture,
  UniversalCamera, Vector3, VertexData, WebGPUEngine,
} from '@babylonjs/core';
import { ComparisonLightmaps, type LightmapState } from './lightmaps';
import { lighting, skyDisplay, sunInterval, type SwitchMode } from './lighting';
import { navigation } from './navigation';
import { CachedTransfer } from './cached-transfer';
import { RoomReflections } from './reflections';
import { loadCouch } from './couch-study';
import { ApartmentLightmap } from '../apartment/lightmap';
import './style.css';

type Vec3 = [number, number, number];
export interface SceneData {
  surfaceInset?: number;
  sampleRepair?: { mesh: number; remap?: number[] };
  materials: { name: string; color: Vec3; roughness: number; transmitting?: boolean;
    diffuseTexture?: { size: number; pixels: number[] };
    metallicTexture?: { size: number; pixels: number[]; factor: number; wrapU: number; wrapV: number } }[];
  meshes: { material: number; positions: number[]; normals: number[]; uvs: number[]; indices: number[]; albedoUvs?: number[]; metallicUvs?: number[] }[];
  fixtures: { position: Vec3; color: Vec3; intensity: number }[];
  views: Record<string, { position: Vec3; target: Vec3; fov: number }>;
  sunHours: number[];
  sky: Vec3;
  references: { view: string; hour: number; on: boolean; file: string }[];
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('scene');
const status = element('status');
const time = element<HTMLInputElement>('time');
const lights = element<HTMLSelectElement>('lights');
const view = element<HTMLSelectElement>('view');
const reference = element<HTMLImageElement>('reference');
const note = element('reference-note');
const base = import.meta.env.BASE_URL + 'comparison/';
const query = new URLSearchParams(location.search);
const couchStudy = query.get('study') === 'applaryd' ? 'applaryd' : 'couch';
const testingCouch = query.get('study') === couchStudy;
const couchName = couchStudy === 'applaryd' ? 'ÄPPLARYD' : 'KLIPPAN';
const study = element<HTMLSelectElement>('study');
study.value = testingCouch ? couchStudy : 'room';
study.addEventListener('change', () => {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ study: study.value, hour: time.value, lights: lights.value }).toString();
  location.assign(url);
});
const hour = Number(query.get('hour') ?? 12);
if (Number.isFinite(hour)) time.value = String(Math.max(0, Math.min(24, hour)));
if (['auto', 'on', 'off'].includes(query.get('lights')!)) lights.value = query.get('lights')!;
else if (testingCouch) lights.value = 'on';
const diffuseBounces = 4;

async function start() {
  const response = await fetch(base + 'scene.json');
  if (!response.ok) throw new Error('Comparison assets are missing. Run scripts/prepare-comparison.py with Blender.');
  const original: SceneData = await response.json();
  const couchData: SceneData | undefined = testingCouch ? await (await fetch(base + `${couchStudy}/scene.json`)).json() : undefined;
  const data = couchData ?? original;
  if (testingCouch) {
    element('layout').parentElement!.hidden = true;
    document.querySelector<HTMLElement>('figure.reference')!.hidden = true;
    element('comparison').style.gridTemplateColumns = '1fr';
    element('comparison').style.maxWidth = '1100px';
    document.querySelector('h1')!.textContent = couchName + ' couch.';
    document.querySelector('header p:last-child')!.textContent = 'Walk around and explore the lighting.';
    document.querySelector('.checkpoints > span')!.textContent = 'LIGHTING PRESETS';
    view.options[0].textContent = 'Furniture & room'; view.options[1].textContent = 'Couch · close view';
    element('scene-note').hidden = false;
    element('scene-note').textContent = 'IKEA ' + couchName + '. Native materials and cached diffuse lighting. No matched Cycles reference is available for this model.';
  }
  let engine: Engine | WebGPUEngine | undefined;
  if (await WebGPUEngine.IsSupportedAsync) {
    const gpu = new WebGPUEngine(canvas, { antialias: true, useExactSrgbConversions: true,
      deviceDescriptor: { requiredFeatures: ['timestamp-query'] } });
    try { await gpu.initAsync(); engine = gpu; }
    catch (error) { gpu.dispose(); console.warn('WebGPU unavailable; using WebGL.', error); }
  }
  engine ??= new Engine(canvas, true, { useExactSrgbConversions: true });
  const activeEngine = engine;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.collisionsEnabled = true;
  const display = scene.imageProcessingConfiguration;
  display.toneMappingEnabled = true;
  display.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  display.exposure = 1 / .6;
  const camera = new UniversalCamera('Comparison camera', Vector3.Zero(), scene);
  camera.inputs.clear();
  camera.inertia = 0;
  camera.minZ = .05;
  camera.maxZ = 60;
  camera.checkCollisions = true;
  camera.ellipsoid.set(.18, .75, .18);
  camera.ellipsoidOffset.set(0, -.09, 0);
  let cameraMatches = true;
  const load = (name: string) => new Promise<Texture>((resolve, reject) => {
    const texture = new Texture(base + name + '.png', scene, true, true, Texture.BILINEAR_SAMPLINGMODE,
      () => resolve(texture), message => reject(new Error(message || 'Could not load ' + name)));
    texture.gammaSpace = false;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  });
  const empty = testingCouch ? RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false) : undefined;
  const [skyMap, fixtureMap, ...sunMaps] = empty ? [empty, empty, ...data.sunHours.map(() => empty)] : await Promise.all([
    load('sky'), load('fixtures'), ...data.sunHours.map(hour => load('sun-' + hour)),
  ]);
  const basis: LightmapState = { sky: 1, fixtures: 0, blend: 0, lower: sunMaps[0], upper: sunMaps[0], fixtureMap,
    cascadeMap: skyMap, useCascades: false };
  const materials = (testingCouch ? original.materials : data.materials).map(source => {
    const material = new PBRMaterial(source.name, scene);
    material.albedoColor = new Color3(...source.color);
    material.metallic = 0;
    material.roughness = source.roughness;
    material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
    material.maxSimultaneousLights = 3;
    material.lightmapTexture = skyMap;
    new ComparisonLightmaps(material, basis);
    return material;
  });
  const meshes = (testingCouch ? data.meshes.slice(0, 2) : data.meshes).map(source => {
    const mesh = new Mesh(materials[source.material].name, scene);
    const vertices = new VertexData();
    vertices.positions = source.positions; vertices.normals = source.normals;
    vertices.uvs = source.uvs; vertices.indices = source.indices;
    vertices.applyToMesh(mesh);
    // Exported Blender triangles use counter-clockwise winding.
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation;
    mesh.material = materials[source.material];
    mesh.receiveShadows = true;
    mesh.checkCollisions = true;
    return mesh;
  });
  if (testingCouch) {
    const couch = await loadCouch(scene, couchStudy);
    const atlas = await (await fetch(base + `${couchStudy}/atlas.json`)).json();
    couch.meshes.forEach((mesh, index) => {
      if (atlas[index].length !== mesh.getTotalVertices() * 2) throw Error('Couch lighting atlas does not match the model.');
      mesh.setVerticesData('uv3', atlas[index]);
    });
    for (const material of couch.materials) {
      material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
      material.maxSimultaneousLights = 3;
      if (!material.needAlphaBlending()) {
        material.lightmapTexture = skyMap;
        new ApartmentLightmap(material, { get texture() { return basis.cascadeMap; }, get ready() { return basis.useCascades; }, sky: 0 });
      }
    }
    materials.push(...couch.materials); meshes.push(...couch.meshes);
  }
  const sun = new DirectionalLight('Sun', new Vector3(0, -1, 0), scene);
  sun.shadowMinZ = .1; sun.shadowMaxZ = 45;
  sun.autoUpdateExtends = false; sun.shadowFrustumSize = 14;
  const sunShadow = new ShadowGenerator(2048, sun);
  sunShadow.usePercentageCloserFiltering = true;
  sunShadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  sunShadow.bias = .0005; sunShadow.normalBias = .005;
  for (const mesh of meshes) sunShadow.addShadowCaster(mesh);
  sunShadow.getShadowMap()!.refreshRate = 0;
  const fixtures = data.fixtures.map((source, index) => {
    const light = new PointLight('Fixed light ' + index, new Vector3(...source.position), scene);
    light.diffuse = new Color3(...source.color); light.specular = light.diffuse;
    light.intensityMode = Light.INTENSITYMODE_LUMINOUSINTENSITY;
    light.falloffType = Light.FALLOFF_GLTF;
    light.shadowMinZ = .05; light.shadowMaxZ = 15;
    const shadow = new ShadowGenerator(1024, light);
    shadow.usePoissonSampling = true;
    shadow.bias = .004; shadow.normalBias = .002;
    for (const mesh of meshes) shadow.addShadowCaster(mesh);
    shadow.getShadowMap()!.refreshRate = 0;
    return light;
  });
  const preparingTransfer = new URLSearchParams(location.search).has('prepareTransfer');
  const reflections = new RoomReflections(scene, meshes.filter(mesh => mesh.material !== materials[0]),
    [{ name: 'Comparison room', center: [0, 1.5, 0], size: [6, 3, 6], materials }], materials);
  reflections.setEnabled(!preparingTransfer && !testingCouch);
  let transfer: CachedTransfer | undefined;
  let transferError = '';
  if (engine instanceof WebGPUEngine && !preparingTransfer) {
    try {
      engine.enableGPUTimingMeasurements = !!engine.getCaps().timerQuery;
      const cache = testingCouch ? couchStudy + '/corrected/transfer.bin.gz' : 'transfer.bin.gz';
      transfer = new CachedTransfer(scene, engine, data, base + cache);
      basis.cascadeMap = transfer.texture;
    } catch (error) { transferError = String(error); console.warn('Cached diffuse unavailable.', error); }
  }
  function updateStatus() {
    const state = lighting(Number(time.value), lights.value as SwitchMode);
    basis.useCascades = !!transfer?.ready && !transfer.error;
    const label = transfer?.status || 'Baked GI fallback';
    const fallback = transferError ? ' · GI initialization failed' : '';
    const text = `${engine instanceof WebGPUEngine ? 'WebGPU' : 'WebGL'} · Lights ${state.on ? 'on' : 'off'} (${lights.value}) · ${label}${fallback} · ${reflections.status}`;
    const message = testingCouch && (!(engine instanceof WebGPUEngine) || !!transfer?.error || !!transferError)
      ? 'Couch GI requires WebGPU and a valid lighting cache · showing direct lighting only.' : text;
    if (status.textContent !== message) status.textContent = message;
  }
  function updateReference() {
    const state = lighting(Number(time.value), lights.value as SwitchMode);
    const match = cameraMatches && data.references.find(item => item.view === view.value && item.hour === Number(time.value) && item.on === state.on);
    reference.hidden = !match;
    note.textContent = !cameraMatches ? 'Free walk · reset the camera to compare.'
      : !match ? 'No exact reference for this time and light state. Select a reference checkpoint above.' : '';
    if (match && !reference.src.endsWith('/' + match.file)) reference.src = base + match.file;
  }
  function resetView() {
    const selected = data.views[view.value];
    camera.position.set(...selected.position);
    camera.setTarget(new Vector3(...selected.target));
    camera.fov = selected.fov;
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
    cameraMatches = true;
    updateReference();
  }
  function applyLighting() {
    const hour = Number(time.value);
    const state = lighting(hour, lights.value as SwitchMode);
    transfer?.setLighting(state, data.sky, diffuseBounces);
    const interval = sunInterval(hour, data.sunHours);
    basis.sky = state.sky; basis.fixtures = Number(state.on); basis.blend = interval.blend;
    basis.lower = sunMaps[interval.lower]; basis.upper = sunMaps[interval.upper];
    sun.direction.set(...state.direction.map(value => -value) as Vec3);
    sun.position.copyFrom(sun.direction.scale(-18));
    sun.position.y += 1.5;
    sun.intensity = state.sun;
    sun.diffuse.set(...state.color as Vec3); sun.specular.copyFrom(sun.diffuse);
    sunShadow.getShadowMap()!.resetRefreshCounter();
    fixtures.forEach((light, index) => { light.intensity = state.on ? data.fixtures[index].intensity : 0; });
    // Clear colour bypasses image processing; show the same exposed sky as the reference.
    scene.clearColor = new Color4(...skyDisplay(data.sky.map(value => value * state.sky) as Vec3), 1);
    const minutes = Math.round(hour * 60);
    element('time-label').textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    updateStatus();
    updateReference();
  }
  time.addEventListener('input', applyLighting);
  lights.addEventListener('change', applyLighting);
  view.addEventListener('change', resetView);
  element('reset').addEventListener('click', resetView);
  document.querySelectorAll<HTMLButtonElement>('[data-hour]').forEach(button => button.addEventListener('click', () => {
    time.value = button.dataset.hour!;
    lights.value = button.dataset.on === 'true' ? 'on' : 'off';
    resetView(); applyLighting();
  }));
  const resize = () => activeEngine.resize();
  element<HTMLSelectElement>('layout').addEventListener('change', event => {
    const value = (event.target as HTMLSelectElement).value;
    element('comparison').className = value;
    element('blend-control').hidden = value !== 'overlay';
    resize();
  });
  element<HTMLInputElement>('blend').addEventListener('input', event => {
    element('comparison').style.setProperty('--reference-opacity', (event.target as HTMLInputElement).value);
  });
  reference.addEventListener('error', () => { reference.hidden = true; note.textContent = 'Reference image failed to load.'; });
  navigation(camera, canvas, () => { if (cameraMatches) { cameraMatches = false; updateReference(); } });
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  window.addEventListener('resize', resize);
  resetView(); applyLighting();
  await scene.whenReadyAsync();
  engine.runRenderLoop(() => {
    transfer?.tick();
    updateStatus();
    const state = lighting(Number(time.value), lights.value as SwitchMode);
    const ready = !transfer || !!transfer.error || (!transfer.diagnostics().updating && transfer.ready);
    reflections.tick(ready ? `${time.value}:${lights.value}:${transfer?.revision ?? 0}` : '',
      data.sky.map(value => value * state.sky));
    scene.render();
  });
  Object.assign(window, { comparison: {
    scene, camera, engine, ready: true,
    state: () => ({ hour: Number(time.value), mode: lights.value, on: lighting(Number(time.value), lights.value as SwitchMode).on,
      couchStudy: testingCouch ? { model: couchStudy } : null,
      bounces: diffuseBounces, activeGi: basis.useCascades ? 'transfer' : 'baked',
      transfer: transfer?.diagnostics(), reflections: reflections.diagnostics(), transferError,
      cameraMatches, reference: reference.hidden ? null : reference.src }),
  } });
  if (preparingTransfer && engine instanceof WebGPUEngine) {
    const gpu = engine;
    Object.assign((window as unknown as { comparison: object }).comparison, {
      prepareTransfer: async () => {
        const { prepareTransfer } = await import('./prepare-transfer');
        return prepareTransfer(data, gpu, fraction => { status.textContent = `Preparing offline transfer · ${Math.round(fraction * 100)}%`; });
      },
    });
  }
  window.addEventListener('pagehide', () => { observer.disconnect(); reflections.dispose(); transfer?.dispose(); scene.dispose(); activeEngine.dispose(); }, { once: true });
}

start().catch(error => { console.error(error); status.textContent = String(error); });
