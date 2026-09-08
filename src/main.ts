import {
  Color3, Color4, Constants, CubeTexture, DirectionalLight, Engine, FrameGraph,
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

const apartment = new URLSearchParams(location.search).get("scene") === "bukit-merah";
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
const view = document.querySelector<HTMLSelectElement>("#view")!;
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
  settingsDialog.showModal();
});
document.querySelector<HTMLButtonElement>("#close-settings")!.addEventListener("click", () => settingsDialog.close());
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
  activeScene.clearColor = new Color4(0.16, 0.20, 0.26, 1);
  const environment = CubeTexture.CreateFromPrefilteredData(
    import.meta.env.BASE_URL + "environments/environmentSpecular.dds", activeScene,
  );
  // Both scenes have baked skylight; retain a reduced diffuse environment fill.
  environment.onLoadObservable.addOnce(() => {
    const polynomial = environment.sphericalPolynomial;
    if (!polynomial) return;
    const harmonics = SphericalHarmonics.FromPolynomial(polynomial);
    harmonics.scaleInPlace(0.35);
    environment.sphericalPolynomial = SphericalPolynomial.FromHarmonics(harmonics);
  });
  activeScene.environmentTexture = environment;
  activeScene.environmentIntensity = 0.65;
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
  sun.intensity = 3;
  const sky = MeshBuilder.CreateBox("sky", { size: 200 }, activeScene);
  sky.infiniteDistance = true;
  sky.isPickable = false;
  const skyMaterial = new SkyMaterial("sky", activeScene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.disableDepthWrite = true;
  skyMaterial.useSunPosition = true;
  skyMaterial.turbidity = 2;
  sky.material = skyMaterial;

  activeEngine.runRenderLoop(() => activeScene.render());
  const bakedUrl = import.meta.env.BASE_URL + (apartment ? "models/bukit-merah/pbr/" : "models/sponza/baked/");
  const response = await fetch(bakedUrl + "lighting.json");
  if (!response.ok) throw new Error("Could not load baked lighting metadata.");
  const lighting = await response.json();
  if (!Number.isFinite(lighting.lightmapScale) || lighting.lightmapScale <= 0) {
    throw new Error("Invalid baked lightmap scale.");
  }
  const modelUrl = new URL(bakedUrl + (apartment ? "Apartment.gltf" : "Sponza.gltf"), document.baseURI);
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) throw new Error("Could not load baked model.");
  const model = await modelResponse.json();
  for (const asset of [...model.images, ...model.buffers]) {
    if (asset.uri) asset.uri = new URL(asset.uri, modelUrl).href;
  }
  const result = await SceneLoader.ImportMeshAsync(
    "", "", "data:" + JSON.stringify(model),
    activeScene, undefined, ".gltf",
  );
  // UV1 has a one-pixel gutter; avoid mipmaps that mix neighboring islands.
  const aoUrl = new URL(apartment ? "../baked/ao.png" : "ao.png", new URL(bakedUrl, document.baseURI));
  const ao = new Texture(aoUrl.href, activeScene, true, false);
  const indirect = new Texture(bakedUrl + "indirect.png", activeScene, true, false);
  for (const texture of [ao, indirect]) {
    texture.coordinatesIndex = 1;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
  ao.gammaSpace = false;
  indirect.gammaSpace = true;
  indirect.level = lighting.lightmapScale;
  for (const material of new Set(result.meshes.map(mesh => mesh.material))) {
    if (!(material instanceof PBRMaterial)) continue;
    material.ambientTexture = ao;
    material.useAmbientInGrayScale = true;
    material.ambientTextureImpactOnAnalyticalLights = 0;
    material.lightmapTexture = indirect;
    material.useLightmapAsShadowmap = false;
  }
  const meshes = result.meshes.filter(mesh => mesh.getTotalVertices() > 0);
  if (!meshes.length) throw new Error(sceneName + " contains no renderable meshes.");
  let minimum = new Vector3(Infinity, Infinity, Infinity);
  let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
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
  if (apartment) {
    view.options[0].textContent = "Living / dining";
    view.options[1].textContent = "Hallway";
    view.options[2].textContent = "Exterior overview";
    view.value = "atrium";
    canvas.setAttribute("aria-label", "Apartment fly camera. Drag to look; use keyboard or touch controls to move.");
  }
  function resetView() {
    if (apartment && view.value === "upper") navigation.value = "fly";
    updateNavigation();
    resetFlight();
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
    const positions: Record<string, Vector3> = {
      atrium: new Vector3(minimum.x + width * 0.16, eye, center.z),
      reverse: new Vector3(maximum.x - width * 0.16, eye, center.z),
      upper: new Vector3(minimum.x + width * 0.23, minimum.y + (maximum.y - minimum.y) * 0.65, center.z),
    };
    if (apartment) {
      positions.atrium = new Vector3(-10.5, 1.65, -5.8);
      positions.reverse = new Vector3(-7.3, 1.65, -4.0);
      positions.upper = new Vector3(-18, 18, 13);
    }
    camera.position.copyFrom(positions[view.value]);
    const target = apartment
      ? (view.value === "upper" ? center : view.value === "atrium" ? new Vector3(-10.5, 1.65, -8.4) : new Vector3(-3, 1.65, -4.0))
      : new Vector3(center.x, eye + 0.5, center.z);
    camera.setTarget(target);
  }
  function updateSunDirection() {
    const azimuth = Number(sunAzimuth.value) * Math.PI / 180;
    const elevation = Number(sunElevation.value) * Math.PI / 180;
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
  shadowTask.mapSize = Number(shadows.value);
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
  shafts.lightPower = new Color3(0.1, 0.1, 0.1);
  shafts.phaseG = 0.05;
  frameGraph.addTask(shafts);

  const bloom = new FrameGraphBloomTask("bloom", frameGraph, 0.12, 32, 1.0, true, 0.5);
  bloom.sourceTexture = shafts.outputTexture;
  frameGraph.addTask(bloom);

  const imageProcessing = new FrameGraphImageProcessingTask("tone-mapping", frameGraph);
  imageProcessing.postProcess.imageProcessingConfiguration = activeScene.imageProcessingConfiguration;
  imageProcessing.sourceTexture = bloom.outputTexture;
  frameGraph.addTask(imageProcessing);
  const antialiasing = new FrameGraphFXAATask("fxaa", frameGraph);
  antialiasing.sourceTexture = imageProcessing.outputTexture;
  antialiasing.targetTexture = backbufferColorTextureHandle;
  antialiasing.disabled = !fxaa.checked;
  frameGraph.addTask(antialiasing);

  let graphBuild = Promise.resolve();
  function rebuildGraph() {
    frameGraph.pausedExecution = true;
    graphBuild = graphBuild.then(() => frameGraph.buildAsync()).then(() => {
      sun.getShadowGenerators()!.set(camera, shadowTask.shadowGenerator!);
      shadowTask.shadowGenerator!.contactHardeningLightSizeUVRatio = Number(shadowSoftness.value);
      volume.lightingVolume.frequency = 0;
      frameGraph.pausedExecution = false;
    });
    return graphBuild;
  }
  function updateShadows() {
    const size = Number(shadows.value);
    const enableShafts = shaftsEnabled.checked;
    shadowTask.mapSize = size || 1024;
    shadowTask.filter = shadowMethod.value === "pcf" ? ShadowGenerator.FILTER_PCF
      : shadowMethod.value === "hard" ? ShadowGenerator.FILTER_NONE : ShadowGenerator.FILTER_PCSS;
    shadowFilter.disabled = !size || shadowMethod.value === "hard";
    shadowSoftness.disabled = !size || shadowMethod.value !== "pcss";
    shadowTask.filteringQuality = shadowFilter.value === "low"
      ? ShadowGenerator.QUALITY_LOW
      : shadowFilter.value === "medium"
        ? ShadowGenerator.QUALITY_MEDIUM
        : ShadowGenerator.QUALITY_HIGH;
    shadowTask.disabled = !size;
    volume.disabled = shafts.disabled = !enableShafts;
    volumeShadowTask.disabled = !enableShafts;
    renderTask.shadowGenerators = size ? [shadowTask] : [];
    activeScene.shadowsEnabled = size !== 0 || enableShafts;
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
  const sunUpdates = activeScene.onBeforeRenderObservable.add(() => {
    if (frameGraph.pausedExecution) return;
    if (sunPending) {
      updateSunDirection();
      sunPending = false;
      volumeDirty = true;
    }
    const now = performance.now();
    // Wait for an in-flight readback and retain the newest requested direction.
    if (!volume.disabled && volumeDirty && !volume.lightingVolume.firstUpdate && now - lastVolumeRefresh >= 100) {
      volume.lightingVolume.frequency = 0;
      volumeDirty = false;
      lastVolumeRefresh = now;
    }
    volumeShadowTask.disabled = volume.disabled || !volume.lightingVolume.firstUpdate;
  });
  sunAzimuth.addEventListener("input", moveSun);
  sunElevation.addEventListener("input", moveSun);
  activeScene.onDisposeObservable.add(() => activeScene.onBeforeRenderObservable.remove(sunUpdates));
  view.addEventListener("change", resetView);
  navigation.addEventListener("change", () => {
    if (navigation.value === "walk") view.value = "atrium";
    resetView();
  });
  for (const control of [shadows, shadowMethod, shadowFilter, shaftsEnabled]) {
    control.addEventListener("change", () => {
      updateShadows();
      void rebuildGraph().catch(fail);
    });
  }
  shadowSoftness.addEventListener("input", () => {
    if (shadowTask.shadowGenerator) shadowTask.shadowGenerator.contactHardeningLightSizeUVRatio = Number(shadowSoftness.value);
    document.querySelector<HTMLOutputElement>("#shadow-softness-value")!.value = Number(shadowSoftness.value).toFixed(3);
  });
  function bindSlider(id: string, digits: number, apply: (value: number) => void) {
    const input = document.querySelector<HTMLInputElement>("#" + id)!;
    const output = document.querySelector<HTMLOutputElement>("#" + id + "-value")!;
    input.addEventListener("input", () => {
      apply(Number(input.value));
      output.value = Number(input.value).toFixed(digits);
    });
  }
  bindSlider("sun-intensity", 1, value => { sun.intensity = value; });
  bindSlider("environment-intensity", 2, value => { activeScene.environmentIntensity = value; });
  bindSlider("shaft-strength", 2, value => { shafts.lightPower = new Color3(value, value, value); });
  bindSlider("bloom-strength", 2, value => { bloom.bloom.weight = value; });
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
  resetView();
  updateShadows();
  resize();
  await graphBuild;
  await activeScene.whenReadyAsync();
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
  scene?.dispose();
  engine?.dispose();
});
