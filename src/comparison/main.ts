import {
  Color3, Color4, Constants, DirectionalLight, Engine, ImageProcessingConfiguration,
  Light, Material, Mesh, PBRMaterial, PointLight, Scene, ShadowGenerator, Texture,
  UniversalCamera, Vector3, VertexData, WebGPUEngine,
} from '@babylonjs/core';
import { ComparisonLightmaps, type LightmapState } from './lightmaps';
import { lighting, sunInterval, type SwitchMode } from './lighting';
import { navigation } from './navigation';
import { RadianceCascades } from './radiance-cascades';
import './style.css';

type Vec3 = [number, number, number];
export interface SceneData {
  materials: { name: string; color: Vec3; roughness: number }[];
  meshes: { material: number; positions: number[]; normals: number[]; uvs: number[]; indices: number[] }[];
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
const gi = element<HTMLSelectElement>('gi');
const bounces = element<HTMLSelectElement>('bounces');
const view = element<HTMLSelectElement>('view');
const reference = element<HTMLImageElement>('reference');
const note = element('reference-note');
const base = import.meta.env.BASE_URL + 'comparison/';

async function start() {
  const response = await fetch(base + 'scene.json');
  if (!response.ok) throw new Error('Comparison assets are missing. Run scripts/prepare-comparison.py with Blender.');
  const data: SceneData = await response.json();
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
  const [skyMap, fixtureMap, ...sunMaps] = await Promise.all([
    load('sky'), load('fixtures'), ...data.sunHours.map(hour => load('sun-' + hour)),
  ]);
  const basis: LightmapState = { sky: 1, fixtures: 0, blend: 0, lower: sunMaps[0], upper: sunMaps[0], fixtureMap,
    cascadeMap: skyMap, useCascades: false };
  const materials = data.materials.map(source => {
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
  const meshes = data.meshes.map(source => {
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
  let cascades: RadianceCascades | undefined;
  let cascadeError = '';
  if (engine instanceof WebGPUEngine) {
    try {
      engine.enableGPUTimingMeasurements = !!engine.getCaps().timerQuery;
      cascades = new RadianceCascades(scene, engine, data);
      basis.cascadeMap = cascades.texture;
    } catch (error) { cascadeError = String(error); console.warn('Radiance cascades unavailable.', error); }
  }
  if (!cascades) {
    gi.value = 'baked';
    gi.querySelector<HTMLOptionElement>('[value="cascades"]')!.disabled = true;
  }
  function updateStatus() {
    bounces.disabled = gi.value !== 'cascades' || !cascades || !!cascades.error;
    const state = lighting(Number(time.value), lights.value as SwitchMode);
    basis.useCascades = gi.value === 'cascades' && !!cascades?.ready && !cascades.error;
    const method = gi.value === 'cascades' ? cascades!.status : 'Baked GI';
    const fallback = !cascades ? (cascadeError ? ' · Cascade initialization failed' : ' · Cascades require WebGPU') : '';
    const text = `${engine instanceof WebGPUEngine ? 'WebGPU' : 'WebGL'} · Lights ${state.on ? 'on' : 'off'} (${lights.value}) · ${method}${fallback}`;
    if (status.textContent !== text) status.textContent = text;
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
    cascades?.setLighting(state, data.sky, Number(bounces.value));
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
  gi.addEventListener('change', updateStatus);
  bounces.addEventListener('change', applyLighting);
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
    if (gi.value === 'cascades') cascades?.tick();
    updateStatus();
    scene.render();
  });
  Object.assign(window, { comparison: {
    scene, camera, engine, ready: true,
    state: () => ({ hour: Number(time.value), mode: lights.value, on: lighting(Number(time.value), lights.value as SwitchMode).on,
      gi: gi.value, bounces: Number(bounces.value), activeGi: basis.useCascades ? 'cascades' : 'baked', cascades: cascades?.diagnostics(),
      cascadeError, cameraMatches, reference: reference.hidden ? null : reference.src }),
  } });
  window.addEventListener('pagehide', () => { observer.disconnect(); cascades?.dispose(); scene.dispose(); activeEngine.dispose(); }, { once: true });
}

function skyDisplay(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb.map(value => value / .6);
  const input = [.59719 * r + .35458 * g + .04823 * b, .076 * r + .90834 * g + .01566 * b, .0284 * r + .13383 * g + .83777 * b];
  const [x, y, z] = input.map(v => (v * (v + .0245786) - .000090537) / (v * (.983729 * v + .432951) + .238081));
  return [1.60475 * x - .53108 * y - .07367 * z, -.10208 * x + 1.10813 * y - .00605 * z, -.00327 * x - .07276 * y + 1.07602 * z]
    .map(v => { const value = Math.min(1, Math.max(0, v)); return value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055; }) as Vec3;
}

start().catch(error => { console.error(error); status.textContent = String(error); });
