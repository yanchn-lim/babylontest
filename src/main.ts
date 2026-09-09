import {
  Color3, Color4, Constants, VertexBuffer, CubeTexture, DirectionalLight, Engine, FrameGraph,
  FrameGraphClearTextureTask, FrameGraphObjectRendererTask, FrameGraphShadowGeneratorTask,
  FrameGraphLightingVolumeTask, FrameGraphVolumetricLightingTask,
  FrameGraphBloomTask, FrameGraphImageProcessingTask, FrameGraphFXAATask, backbufferColorTextureHandle, Matrix,
  ImageProcessingConfiguration, MeshBuilder, PBRMaterial, Scene, SceneLoader,
  ShadowGenerator, SphericalHarmonics, SphericalPolynomial, Texture, UniversalCamera, Vector3,
} from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials/sky";
import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Debug/debugLayer";
import "./style.css";
import { attachFlyControls } from "./fly-controls";
import { ShadowCache, createRebuildQueue } from "./performance";
import { attachDayNight } from "./day-night";
import { attachMaterialControls } from "./material-controls";
import { attachGraphicsPreferences } from "./graphics-settings";
import { attachBenchmark } from "./benchmark";
import { DirectionalLightmapPlugin } from "./directional-lightmap";
import { BloomToneMappingTask } from "./bloom-tone-mapping";
import { bindSurfaceShadow, trackShadowCasters } from "./shadow-binding";
const preferences = attachGraphicsPreferences();

const apartment = new URLSearchParams(location.search).get("scene") === "bukit-merah";
const optimizedRenderer = new URLSearchParams(location.search).get("renderer") !== "baseline";
const sceneSelect = document.querySelector<HTMLSelectElement>("#scene-select")!;
sceneSelect.value = apartment ? "bukit-merah" : "sponza";
sceneSelect.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("scene", sceneSelect.value);
  location.assign(url.href);
});
const sceneName = apartment ? "Bukit Merah Ridge · 4-room" : "Sponza";
document.querySelector("h1")!.textContent = sceneName;
document.title = sceneName + " · Babylon.js Lab";
const sourceLink = document.querySelector<HTMLAnchorElement>("#model-source")!;
sourceLink.href = import.meta.env.BASE_URL + (apartment ? "models/bukit-merah/SOURCE.md" : "models/sponza/SOURCE.md");

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const controls = document.querySelector<HTMLFieldSetElement>("#controls")!;
const navigation = document.querySelector<HTMLSelectElement>("#navigation")!;
navigation.value = apartment ? "walk" : "fly";
document.querySelector<HTMLElement>("#navigation-setting")!.hidden = !apartment;
const shadows = document.querySelector<HTMLSelectElement>("#shadows")!;
const shadowFilter = document.querySelector<HTMLSelectElement>("#shadow-filter")!;
const shaftsEnabled = document.querySelector<HTMLInputElement>("#shafts")!;
const shadowMethod = document.querySelector<HTMLSelectElement>("#shadow-method")!;
const shadowSoftness = document.querySelector<HTMLInputElement>("#shadow-softness")!;
const bloomEnabled = document.querySelector<HTMLInputElement>("#bloom-enabled")!;
const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
document.querySelector<HTMLButtonElement>("#open-settings")!.addEventListener("click", () => {
  if (document.pointerLockElement) document.exitPointerLock();
  settingsDialog.show();
});
document.querySelector<HTMLButtonElement>("#close-settings")!.addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); settingsDialog.close(); }
});
settingsDialog.addEventListener("close", () => canvas.focus());
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-section]"))) {
  button.addEventListener("click", () => {
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"))) panel.hidden = panel.dataset.panel !== button.dataset.section;
    for (const item of Array.from(document.querySelectorAll<HTMLElement>("[data-section]"))) item.setAttribute("aria-pressed", String(item === button));
    document.querySelector(".panel-body")!.scrollTop = 0;
  });
}
const sunAzimuth = document.querySelector<HTMLInputElement>("#sun-azimuth")!;
const sunElevation = document.querySelector<HTMLInputElement>("#sun-elevation")!;
const exposure = document.querySelector<HTMLInputElement>("#exposure")!;
const scale = document.querySelector<HTMLSelectElement>("#scale")!;
const fxaa = document.querySelector<HTMLInputElement>("#fxaa")!;
const inspector = document.querySelector<HTMLButtonElement>("#inspector")!;

let engine: Engine | undefined;
let scene: Scene | undefined;
let statistics: ReturnType<typeof setInterval> | undefined;

function fail(error: unknown) {
  console.error(error);
  status.classList.add("error");
  status.textContent = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

canvas.addEventListener("webglcontextlost", () => {
  fail("Graphics context lost. The scene may exceed available graphics memory.");
});

window.addEventListener("error", event => {
  fail(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", event => {
  fail(event.reason);
});

async function start() {
  engine = new Engine(canvas, false, { stencil: true });
  scene = new Scene(engine);
  const activeEngine = engine;
  const activeScene = scene;
  const dayNight = attachDayNight();
  activeScene.onDisposeObservable.add(() => dayNight.dispose());
  activeScene.clearColor = new Color4(0.16, 0.20, 0.26, 1);
  const environment = CubeTexture.CreateFromPrefilteredData(
    import.meta.env.BASE_URL + "environments/environmentSpecular.dds", activeScene,
  );
  // Always scale the original coefficients, so slider edits do not accumulate.
  let environmentPolynomial: SphericalPolynomial | null = null;
  function updateEnvironmentDiffuse(value: number) {
    environmentPolynomial ??= environment.sphericalPolynomial;
    if (!environmentPolynomial) return;
    const harmonics = SphericalHarmonics.FromPolynomial(environmentPolynomial);
    harmonics.scaleInPlace(value);
    environment.sphericalPolynomial = SphericalPolynomial.FromHarmonics(harmonics);
  }
  environment.onLoadObservable.addOnce(() => {
    updateEnvironmentDiffuse(Number(document.querySelector<HTMLInputElement>("#environment-diffuse")!.value));
  });
  activeScene.environmentTexture = environment;
  activeScene.environmentIntensity = Number(document.querySelector<HTMLInputElement>("#environment-intensity")!.value);
  activeScene.imageProcessingConfiguration.toneMappingEnabled = true;
  activeScene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  activeScene.imageProcessingConfiguration.exposure = Number(exposure.value);
  const camera = new UniversalCamera("camera", new Vector3(0, 2, 0), activeScene);
  camera.minZ = 0.05;
  camera.maxZ = 250;
  camera.inputs.clear();
  camera.inertia = 0;
  camera.ellipsoid.set(0.2, 0.75, 0.2);
  camera.ellipsoidOffset.set(0, -0.14, 0);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), activeScene);
  sun.position = new Vector3(12, 22, 8);
  sun.intensity = Number(document.querySelector<HTMLInputElement>("#sun-intensity")!.value);
  const sky = MeshBuilder.CreateBox("sky", { size: 200 }, activeScene);
  sky.infiniteDistance = true;
  sky.isPickable = false;
  const skyMaterial = new SkyMaterial("sky", activeScene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.disableDepthWrite = true;
  skyMaterial.useSunPosition = true;
  skyMaterial.turbidity = 2;
  sky.material = skyMaterial;
  const skyColors = new Float32Array(sky.getTotalVertices() * 4).fill(1);
  sky.setVerticesData(VertexBuffer.ColorKind, skyColors, true);

  activeEngine.runRenderLoop(() => activeScene.render());
  const bakedUrl = import.meta.env.BASE_URL + (apartment ? "models/bukit-merah/pbr/" : "models/sponza/baked/");
  const response = await fetch(bakedUrl + "lighting.json", { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load baked lighting metadata.");
  const lighting = await response.json();
  if (!Number.isFinite(lighting.lightmapScale) || lighting.lightmapScale <= 0) {
    throw new Error("Invalid baked lightmap scale.");
  }
  const modelUrl = new URL(bakedUrl + (apartment ? "Apartment.gltf" : "Sponza.gltf"), document.baseURI);
  modelUrl.searchParams.set("v", lighting.sha256[apartment ? "Apartment.gltf" : "Sponza.gltf"]);
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) throw new Error("Could not load baked model.");
  const model = await modelResponse.json();
  for (const asset of [...model.images, ...model.buffers]) {
    if (asset.uri) {
      const uri = asset.uri;
      const url = new URL(uri, modelUrl);
      if (lighting.sha256[uri]) url.searchParams.set("v", lighting.sha256[uri]);
      asset.uri = url.href;
    }
  }
  const result = await SceneLoader.ImportMeshAsync(
    "", "", "data:" + JSON.stringify(model),
    activeScene, undefined, ".gltf",
  );
  // UV1 has a one-pixel gutter; avoid mipmaps that mix neighboring islands.
  const aoUrl = new URL(apartment ? "../baked/ao.png" : "ao.png", new URL(bakedUrl, document.baseURI));
  const ao = new Texture(aoUrl.href, activeScene, {
    noMipmap: true, invertY: false,
    format: optimizedRenderer && activeEngine.webGLVersion > 1 ? Constants.TEXTUREFORMAT_RED : Constants.TEXTUREFORMAT_RGBA,
  });
  const indirect = new Texture(bakedUrl + "indirect.png?v=" + lighting.sha256["indirect.png"], activeScene, true, false);
  for (const texture of [ao, indirect]) {
    texture.coordinatesIndex = 1;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
  ao.gammaSpace = false;
  indirect.gammaSpace = true;
  indirect.level = lighting.lightmapScale;
  const directionalControl = document.querySelector<HTMLInputElement>("#directional-lightmaps")!;
  document.querySelector<HTMLElement>("#directional-lightmaps-setting")!.hidden = !apartment;
  let direction: Texture | undefined;
  const directionalPlugins: DirectionalLightmapPlugin[] = [];
  if (apartment && lighting.directional) {
    if (lighting.directional.version !== 1 || lighting.directional.space !== "glTF model"
      || lighting.directional.file !== "direction.png" || !/^[a-f0-9]{64}$/.test(lighting.sha256["direction.png"] ?? "")
      || lighting.directional.referenceLightmapSha256 !== lighting.sha256["indirect.png"]) {
      throw new Error("Directional lighting does not match the current lightmap.");
    }
    direction = new Texture(bakedUrl + "direction.png?v=" + lighting.sha256["direction.png"], activeScene, true, false,
      Texture.BILINEAR_SAMPLINGMODE, undefined, message => fail(new Error(message ?? "Could not load directional lightmap.")));
    direction.gammaSpace = false;
    direction.coordinatesIndex = 1;
    direction.wrapU = direction.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
  directionalControl.disabled = !direction;
  document.querySelector<HTMLElement>("#directional-strength-setting")!.hidden = !direction;
  directionalControl.addEventListener("change", () => {
    for (const plugin of directionalPlugins) plugin.strength = directionalControl.checked ? Number(document.querySelector<HTMLInputElement>("#directional-strength")!.value) : 0;
  });
  for (const material of new Set(result.meshes.map(mesh => mesh.material))) {
    if (!(material instanceof PBRMaterial)) continue;
    material.ambientTexture = ao;
    material.useAmbientInGrayScale = true;
    material.ambientTextureImpactOnAnalyticalLights = 0;
    material.lightmapTexture = indirect;
    material.useLightmapAsShadowmap = false;
    if (direction && material.bumpTexture) {
      const plugin = new DirectionalLightmapPlugin(material, direction);
      plugin.strength = directionalControl.checked ? Number(document.querySelector<HTMLInputElement>("#directional-strength")!.value) : 0;
      directionalPlugins.push(plugin);
    }
    material.needDepthPrePass = optimizedRenderer && !material.needAlphaBlending() && !material.needAlphaTesting();
  }
  const effectControls = [
    [bloomEnabled, ["bloom-strength", "bloom-threshold", "bloom-radius"]],
    [shaftsEnabled, ["shaft-strength", "shaft-scattering"]],
    [directionalControl, ["directional-strength"]],
  ] as const;
  for (const [toggle, ids] of effectControls) {
    const sync = () => { for (const id of ids) document.querySelector<HTMLInputElement>("#" + id)!.disabled = !toggle.checked || toggle.disabled; };
    toggle.addEventListener("change", sync);
    sync();
  }
  const meshes = result.meshes.filter(mesh => mesh.getTotalVertices() > 0);
  const materialControls = attachMaterialControls(meshes, apartment ? "bukit-merah" : "sponza");
  if (!meshes.length) throw new Error(sceneName + " contains no renderable meshes.");
  let minimum = new Vector3(Infinity, Infinity, Infinity);
  let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    if (optimizedRenderer) mesh.freezeWorldMatrix();
    mesh.receiveShadows = true;
    mesh.checkCollisions = apartment;
    const bounds = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
    maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
  }
  const center = minimum.add(maximum).scale(0.5);
  const width = maximum.x - minimum.x;
  const eye = minimum.y + 1.7;
  const resetFlight = attachFlyControls(camera, canvas, () => apartment && navigation.value === "walk");
  function updateNavigation() {
    const walking = apartment && navigation.value === "walk";
    camera.checkCollisions = walking;
    document.querySelector<HTMLElement>(".height-controls")!.hidden = walking;
    document.querySelector<HTMLElement>(".desktop-hint")!.innerHTML = walking
      ? "WASD / arrows: walk<br>Shift: faster · Drag: look · Esc: release mouse"
      : "WASD / arrows: fly · E / Q: up / down<br>Shift: faster · Drag: look · Esc: release mouse";
    document.querySelector<HTMLElement>(".mobile-hint")!.innerHTML = walking
      ? "Left stick: walk · Drag scene: look"
      : "Left stick: fly · Drag scene: look<br>Hold Up / Down to change height.";
    canvas.setAttribute("aria-label", walking
      ? "Apartment walking camera. Drag to look; use keyboard or touch controls to walk."
      : "Fly camera. Drag to look; use keyboard or touch controls to move.");
    document.querySelector<HTMLElement>("#move-stick")!.setAttribute("aria-label",
      walking ? "Drag to walk forward, backward, or sideways" : "Drag to fly forward, backward, or sideways");
  }
  function resetView() {
    updateNavigation();
    resetFlight();
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
    camera.position.copyFrom(apartment
      ? new Vector3(-10.5, 1.65, -5.8)
      : new Vector3(minimum.x + width * 0.16, eye, center.z));
    const target = apartment
      ? new Vector3(-10.5, 1.65, -8.4)
      : new Vector3(center.x, eye + 0.5, center.z);
    camera.setTarget(target);
  }
  function updateSunDirection() {
    const daylight = dayNight.sample();
    const azimuth = (daylight?.azimuth ?? Number(sunAzimuth.value)) * Math.PI / 180;
    const elevation = (daylight?.elevation ?? Number(sunElevation.value)) * Math.PI / 180;
    sun.direction.set(-Math.cos(elevation) * Math.cos(azimuth), -Math.sin(elevation), -Math.cos(elevation) * Math.sin(azimuth));
    sun.position.copyFrom(center.subtract(sun.direction.scale(Vector3.Distance(minimum, maximum))));
    skyMaterial.sunPosition.copyFrom(sun.direction).scaleInPlace(-1000);
    document.querySelector<HTMLOutputElement>("#sun-azimuth-value")!.value = sunAzimuth.value;
    document.querySelector<HTMLOutputElement>("#sun-elevation-value")!.value = sunElevation.value;
    // Keep shadow coverage fitted to the whole model as the sun rotates.
    const lightView = Matrix.LookAtLH(sun.position, sun.position.add(sun.direction), Vector3.Up());
    let lightMinimum = new Vector3(Infinity, Infinity, Infinity);
    let lightMaximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of meshes) {
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        const point = Vector3.TransformCoordinates(corner, lightView);
        lightMinimum = Vector3.Minimize(lightMinimum, point);
        lightMaximum = Vector3.Maximize(lightMaximum, point);
      }
    }
    sun.autoUpdateExtends = false;
    sun.shadowOrthoScale = 0;
    sun.orthoLeft = lightMinimum.x - 1;
    sun.orthoRight = lightMaximum.x + 1;
    sun.orthoBottom = lightMinimum.y - 1;
    sun.orthoTop = lightMaximum.y + 1;
    sun.shadowMinZ = lightMinimum.z - 1;
    sun.shadowMaxZ = lightMaximum.z + 1;
  }
  updateSunDirection();

  const frameGraph = new FrameGraph(activeScene);
  frameGraph.pausedExecution = true;
  activeScene.frameGraph = frameGraph;
  activeScene.cameraToUseForPointers = camera;
  function target(name: string, format: number, type: number, percentage = 100) {
    return frameGraph.textureManager.createRenderTargetTexture(name, {
      size: { width: percentage, height: percentage }, sizeIsPercentage: true,
      options: { createMipMaps: false, types: [type], formats: [format], samples: 1 },
    });
  }
  const color = target("scene-color", Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_HALF_FLOAT);
  const depth = target("scene-depth", Constants.TEXTUREFORMAT_DEPTH32_FLOAT, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  const volumeColor = target("sun-volume-color", Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_HALF_FLOAT, 50);
  const clear = new FrameGraphClearTextureTask("clear", frameGraph);
  clear.targetTexture = color;
  clear.depthTexture = depth;
  clear.clearColor = clear.clearDepth = true;
  clear.color = activeScene.clearColor;
  clear.convertColorToLinearSpace = true;
  frameGraph.addTask(clear);

  const shadowTask = new FrameGraphShadowGeneratorTask("sun-shadows", frameGraph);
  shadowTask.objectList = { meshes, particleSystems: [] };
  shadowTask.light = sun;
  shadowTask.camera = camera;
  shadowTask.mapSize = Number(shadows.value) || 1024;
  shadowTask.filter = ShadowGenerator.FILTER_PCSS;
  shadowTask.bias = 0.0005;
  shadowTask.normalBias = 0.02;
  frameGraph.addTask(shadowTask);

  // Light shafts need a much smaller depth map than visible surface shadows.
  const volumeShadowTask = new FrameGraphShadowGeneratorTask("sun-volume-depth", frameGraph);
  volumeShadowTask.objectList = { meshes, particleSystems: [] };
  volumeShadowTask.light = sun;
  volumeShadowTask.camera = camera;
  volumeShadowTask.mapSize = 512;
  volumeShadowTask.filter = ShadowGenerator.FILTER_PCF;
  volumeShadowTask.bias = shadowTask.bias;
  volumeShadowTask.normalBias = shadowTask.normalBias;
  frameGraph.addTask(volumeShadowTask);

  const renderTask = new FrameGraphObjectRendererTask("scene", frameGraph, activeScene);
  renderTask.targetTexture = clear.outputTexture;
  renderTask.depthTexture = clear.outputDepthTexture;
  renderTask.objectList = { meshes: [sky, ...meshes], particleSystems: [] };
  renderTask.camera = camera;
  renderTask.disableImageProcessing = true;
  renderTask.isMainObjectRenderer = true;
  renderTask.shadowGenerators = [shadowTask];
  frameGraph.addTask(renderTask);

  const volume = new FrameGraphLightingVolumeTask("sun-volume", frameGraph);
  volume.shadowGenerator = volumeShadowTask;
  // Reuse the lighting volume while the sun and model remain static.
  volume.lightingVolume.frequency = 0;
  volume.lightingVolume.tesselation = 128;
  frameGraph.addTask(volume);
  const shafts = new FrameGraphVolumetricLightingTask("sun-shafts", frameGraph, false);
  shafts.targetTexture = renderTask.outputTexture;
  shafts.depthTexture = renderTask.outputDepthTexture;
  shafts.camera = camera;
  shafts.light = sun;
  shafts.lightingVolumeMesh = volume.outputMeshLightingVolume;
  shafts.lightingVolumeTexture = volumeColor;
  const shaftStrength = Number(document.querySelector<HTMLInputElement>("#shaft-strength")!.value);
  shafts.lightPower = new Color3(shaftStrength, shaftStrength, shaftStrength);
  shafts.phaseG = 0.05;
  frameGraph.addTask(shafts);

  const bloom = new FrameGraphBloomTask("bloom", frameGraph,
    Number(document.querySelector<HTMLInputElement>("#bloom-strength")!.value), 32, 1.0, true, 0.5);
  bloom.disabled = !bloomEnabled.checked;
  bloom.sourceTexture = shafts.outputTexture;
  // The fused tone task disables bloom's merge and copy passes.
  if (optimizedRenderer) bloom.targetTexture = shafts.outputTexture;
  frameGraph.addTask(bloom);

  const imageProcessing = optimizedRenderer
    ? new BloomToneMappingTask("tone-mapping", frameGraph, bloom)
    : new FrameGraphImageProcessingTask("tone-mapping", frameGraph);
  imageProcessing.postProcess.imageProcessingConfiguration = activeScene.imageProcessingConfiguration;
  imageProcessing.sourceTexture = optimizedRenderer ? shafts.outputTexture : bloom.outputTexture;
  if (optimizedRenderer) imageProcessing.targetTexture = target("display-color", Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  frameGraph.addTask(imageProcessing);
  const antialiasing = new FrameGraphFXAATask("fxaa", frameGraph);
  antialiasing.sourceTexture = imageProcessing.outputTexture;
  antialiasing.targetTexture = backbufferColorTextureHandle;
  antialiasing.disabled = !fxaa.checked;
  frameGraph.addTask(antialiasing);

  const shadowCache = new ShadowCache();
  let shadowRevision: number | null = null;
  let shadowRenders = 0;
  let graphBuildCount = 0;
  let graphFailed = false;
  const graphTasks = [...frameGraph.tasks];
  let resolveFirstBuild!: () => void;
  const firstBuildReady = new Promise<void>(resolve => { resolveFirstBuild = resolve; });
  const retryGraphics = document.querySelector<HTMLButtonElement>("#retry-graphics")!;
  const requestBuild = createRebuildQueue(async () => {
    frameGraph.pausedExecution = true;
    try {
      // A failed Babylon build clears its task list; retain the tasks for retry.
      if (!frameGraph.tasks.length) for (const task of graphTasks) frameGraph.addTask(task);
      shadowTask.mapSize = Number(shadows.value) || 1024;
      shadowTask.filter = shadowMethod.value === "pcf" ? ShadowGenerator.FILTER_PCF
        : shadowMethod.value === "hard" ? ShadowGenerator.FILTER_NONE : ShadowGenerator.FILTER_PCSS;
      await frameGraph.buildAsync();
      graphBuildCount++;
      bindSurfaceShadow(sun, camera, shadowTask.shadowGenerator!);
      shadowTask.shadowGenerator!.contactHardeningLightSizeUVRatio = Number(shadowSoftness.value);
      shadowCache.invalidate();
      volume.lightingVolume.frequency = 0;
      graphFailed = false;
      resolveFirstBuild();
      retryGraphics.hidden = true;
      status.classList.remove("error");
      status.textContent = "Ready · " + meshes.length + " meshes";
      frameGraph.pausedExecution = false;
    } catch (error) {
      graphFailed = true;
      retryGraphics.hidden = false;
      frameGraph.pausedExecution = true;
      throw error;
    }
  });
  let graphBuild = Promise.resolve();
  function rebuildGraph() {
    frameGraph.pausedExecution = true;
    graphBuild = requestBuild();
    return graphBuild;
  }
  retryGraphics.addEventListener("click", () => { void rebuildGraph().catch(fail); });
  const contextRestored = activeEngine.onContextRestoredObservable.add(() => { void rebuildGraph().catch(fail); });
  activeScene.onDisposeObservable.add(() => activeEngine.onContextRestoredObservable.remove(contextRestored));
  shadowTask.onAfterTaskExecute.add(() => {
    if (!shadowTask.disabled) { shadowCache.complete(shadowRevision); shadowRenders++; }
  });
  function updateShadows() {
    const size = Number(shadows.value);
    const enableShafts = shaftsEnabled.checked && (dayNight.sample()?.sun ?? 1) > 0;

    shadowFilter.disabled = !size || shadowMethod.value === "hard";
    shadowSoftness.disabled = !size || shadowMethod.value !== "pcss";
    shadowTask.filteringQuality = shadowFilter.value === "low"
      ? ShadowGenerator.QUALITY_LOW
      : shadowFilter.value === "medium"
        ? ShadowGenerator.QUALITY_MEDIUM
        : ShadowGenerator.QUALITY_HIGH;
    if (volume.disabled && enableShafts) volume.lightingVolume.frequency = 0;
    volume.disabled = shafts.disabled = !enableShafts;
    volumeShadowTask.disabled = !enableShafts;
    renderTask.disableShadows = !size;
    activeScene.shadowsEnabled = true;
    shadowCache.invalidate();
  }
  function resize() {
    activeEngine.setHardwareScalingLevel(1 / (window.devicePixelRatio * Number(scale.value)));
    activeEngine.resize();
    void rebuildGraph().catch(fail);
  }
  activeScene.onDisposeObservable.add(() => frameGraph.dispose());
  let sunPending = false;
  let volumeDirty = false;
  let lastVolumeRefresh = -Infinity;
  function moveSun() {
    sunPending = true;
  }
  const casterStates = new Map<typeof meshes[number], string>();
  const sunUpdates = activeScene.onBeforeRenderObservable.add(() => {
    dayNight.tick(performance.now(), frameGraph.pausedExecution);
    if (frameGraph.pausedExecution) return;
    const castersChanged = trackShadowCasters(meshes, casterStates);
    if (sunPending || castersChanged) {
      updateSunDirection();
      applyDaylight();
      shadowCache.invalidate();
      sunPending = false;
      volumeDirty = true;
    }
    shadowRevision = shadowCache.begin(Number(shadows.value) !== 0 && (dayNight.sample()?.sun ?? 1) > 0);
    shadowTask.disabled = shadowRevision === null;
    const now = performance.now();
    // Wait for an in-flight readback and retain the newest requested direction.
    if (!volume.disabled && volumeDirty && !volume.lightingVolume.firstUpdate && now - lastVolumeRefresh >= 100) {
      volume.lightingVolume.frequency = 0;
      volumeDirty = false;
      lastVolumeRefresh = now;
    }
    volumeShadowTask.disabled = volume.disabled || !volume.lightingVolume.firstUpdate;
  });
  document.querySelector("#day-time")!.addEventListener("input", moveSun);
  document.querySelector("#day-cycle")!.addEventListener("change", moveSun);
  sunAzimuth.addEventListener("input", moveSun);
  sunElevation.addEventListener("input", moveSun);
  activeScene.onDisposeObservable.add(() => activeScene.onBeforeRenderObservable.remove(sunUpdates));
  navigation.addEventListener("change", resetView);
  for (const control of [shadows, shadowMethod, shadowFilter, shaftsEnabled]) {
    control.addEventListener("change", () => {
      updateShadows();
      if (control === shadows || control === shadowMethod || graphFailed) void rebuildGraph().catch(fail);
    });
  }
  shadowSoftness.addEventListener("input", () => {
    if (shadowTask.shadowGenerator) shadowTask.shadowGenerator.contactHardeningLightSizeUVRatio = Number(shadowSoftness.value);
    document.querySelector<HTMLOutputElement>("#shadow-softness-value")!.value = Number(shadowSoftness.value).toFixed(3);
  });
  function bindSlider(id: string, digits: number, apply: (value: number) => void) {
    const input = document.querySelector<HTMLInputElement>("#" + id)!;
    const output = document.querySelector<HTMLOutputElement>("#" + id + "-value")!;
    apply(Number(input.value));
    output.value = Number(input.value).toFixed(digits);
    input.addEventListener("input", () => {
      apply(Number(input.value));
      output.value = Number(input.value).toFixed(digits);
    });
  }
  function applyDaylight() {
    const daylight = dayNight.sample();
    const value = (id: string) => Number(document.querySelector<HTMLInputElement>("#" + id)!.value);
    const warmth = daylight?.warmth ?? value("sun-warmth");
    sun.diffuse.set(1, 1 - warmth * 0.12, 1 - warmth * 0.25);
    sun.specular.copyFrom(sun.diffuse);
    sun.intensity = value("sun-intensity") * (daylight?.sun ?? 1);
    activeScene.environmentIntensity = value("environment-intensity") * (daylight?.ambient ?? 1);
    indirect.level = lighting.lightmapScale * value("baked-intensity") * (daylight?.ambient ?? 1);
    const strength = value("shaft-strength") * (daylight?.sun ?? 1);
    shafts.lightPower.set(strength, strength, strength);
    const skyStrength = daylight?.sky ?? 1;
    for (let i = 0; i < skyColors.length; i += 4) {
      skyColors[i] = skyColors[i + 1] = skyColors[i + 2] = skyStrength;
    }
    sky.updateVerticesData(VertexBuffer.ColorKind, skyColors);
    const wantShafts = shaftsEnabled.checked && (daylight?.sun ?? 1) > 0;
    if (wantShafts !== !volume.disabled) updateShadows();
  }
  bindSlider("sun-warmth", 2, applyDaylight);
  bindSlider("directional-strength", 2, value => { for (const plugin of directionalPlugins) plugin.strength = directionalControl.checked ? value : 0; });
  bindSlider("shadow-bias", 4, value => { shadowTask.bias = value; shadowCache.invalidate(); });
  bindSlider("shadow-normal-bias", 3, value => { shadowTask.normalBias = value; shadowCache.invalidate(); });
  bindSlider("sun-intensity", 1, applyDaylight);
  bindSlider("environment-intensity", 2, applyDaylight);
  bindSlider("environment-diffuse", 2, updateEnvironmentDiffuse);
  bindSlider("baked-intensity", 2, applyDaylight);
  bindSlider("ao-strength", 2, value => {
    for (const material of new Set(result.meshes.map(mesh => mesh.material))) {
      if (material instanceof PBRMaterial) material.ambientTextureStrength = value;
    }
  });
  bindSlider("shaft-strength", 2, applyDaylight);
  bindSlider("bloom-strength", 2, value => { bloom.bloom.weight = value; });
  bindSlider("contrast", 2, value => { activeScene.imageProcessingConfiguration.contrast = value; });
  bindSlider("bloom-threshold", 2, value => { bloom.bloom.threshold = value; });
  bindSlider("bloom-radius", 0, value => { bloom.bloom.kernel = value; });
  bindSlider("shaft-scattering", 2, value => { shafts.phaseG = value; });
  bloomEnabled.addEventListener("change", () => { bloom.disabled = !bloomEnabled.checked; });
  exposure.addEventListener("input", () => {
    activeScene.imageProcessingConfiguration.exposure = Number(exposure.value);
    document.querySelector<HTMLOutputElement>("#exposure-value")!.value = Number(exposure.value).toFixed(1);
  });
  fxaa.addEventListener("change", () => { antialiasing.disabled = !fxaa.checked; });
  scale.addEventListener("change", resize);
  window.addEventListener("resize", resize);
  activeScene.onDisposeObservable.add(() => window.removeEventListener("resize", resize));
  inspector.addEventListener("click", async () => {
    inspector.disabled = true;
    try {
      settingsDialog.close();
      await import("@babylonjs/inspector");
      if (activeScene.debugLayer.isVisible()) activeScene.debugLayer.hide();
      else await activeScene.debugLayer.show({ embedMode: true });
      inspector.textContent = activeScene.debugLayer.isVisible() ? "Close inspector" : "Open inspector";
    } catch (error) {
      console.error(error);
      status.textContent = "Inspector could not open. See the console for details.";
    } finally { inspector.disabled = false; }
  });
  document.querySelector<HTMLButtonElement>("#reset-graphics")!.addEventListener("click", () => { preferences.reset(); materialControls.reset(); });
  document.querySelector<HTMLButtonElement>("#balance-lighting")!.addEventListener("click", () => preferences.balanceLighting());
  document.querySelector<HTMLOutputElement>("#shadow-softness-value")!.value = Number(shadowSoftness.value).toFixed(3);
  document.querySelector<HTMLOutputElement>("#exposure-value")!.value = Number(exposure.value).toFixed(1);
  resetView();
  updateShadows();
  resize();
  await graphBuild.catch(fail);
  await firstBuildReady;
  await activeScene.whenReadyAsync();
  updateEnvironmentDiffuse(Number(document.querySelector<HTMLInputElement>("#environment-diffuse")!.value));
  shadowCache.invalidate();
  const disposeBenchmark = attachBenchmark(activeEngine, activeScene, camera, () => ({ ...preferences.snapshot(), materials: materialControls.snapshot(), cyclePlaying: dayNight.playing }),
    () => frameGraph.pausedExecution || graphFailed,
    () => ({ rendererProfile: optimizedRenderer ? "optimized" : "baseline-7052765",
      shadowMapRenders: shadowRenders, graphBuilds: graphBuildCount,
      surfaceMapSize: shadowTask.shadowGenerator!.mapSize,
      surfaceBindingCorrect: sun.getShadowGenerator(camera) === shadowTask.shadowGenerator }));
  activeScene.onDisposeObservable.add(disposeBenchmark);
  controls.disabled = false;
  document.querySelector<HTMLElement>("#flight-controls")!.hidden = false;
  document.querySelector<HTMLButtonElement>("#capture-mouse")!.disabled = false;
  status.textContent = "Ready \u00b7 " + meshes.length + " meshes";
  document.querySelector("#renderer")!.textContent = "WebGL " + activeEngine.webGLVersion;
  statistics = setInterval(() => {
    document.querySelector("#fps")!.textContent = activeEngine.getFps().toFixed(0) + " fps";
    document.querySelector("#frame")!.textContent = activeEngine.getDeltaTime().toFixed(1) + " ms";
    document.querySelector("#resolution")!.textContent = activeEngine.getRenderWidth() + " \u00d7 " + activeEngine.getRenderHeight();
  }, 500);
}

void start().catch(fail);
if (import.meta.hot) import.meta.hot.dispose(() => {
  clearInterval(statistics);
  preferences.dispose();
  scene?.dispose();
  engine?.dispose();
});
