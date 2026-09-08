import {
  Color3, Color4, Constants, CubeTexture, DirectionalLight, Engine, FrameGraph,
  FrameGraphClearTextureTask, FrameGraphObjectRendererTask, FrameGraphShadowGeneratorTask,
  FrameGraphLightingVolumeTask, FrameGraphVolumetricLightingTask,
  FrameGraphBloomTask, FrameGraphImageProcessingTask, FrameGraphFXAATask, backbufferColorTextureHandle, Matrix,
  ImageProcessingConfiguration, PBRMaterial, Scene, SceneLoader,
  ShadowGenerator, SphericalHarmonics, SphericalPolynomial, Texture, UniversalCamera, Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Debug/debugLayer";
import "./style.css";
import { attachFlyControls } from "./fly-controls";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const controls = document.querySelector<HTMLFieldSetElement>("#controls")!;
const view = document.querySelector<HTMLSelectElement>("#view")!;
const shadows = document.querySelector<HTMLSelectElement>("#shadows")!;
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
  // Add a reduced diffuse environment fill to the baked skylight.
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

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), activeScene);
  sun.position = new Vector3(12, 22, 8);
  sun.intensity = 3;

  activeEngine.runRenderLoop(() => activeScene.render());
  const bakedUrl = import.meta.env.BASE_URL + "models/sponza/baked/";
  const response = await fetch(bakedUrl + "lighting.json");
  if (!response.ok) throw new Error("Could not load baked lighting metadata.");
  const lighting = await response.json();
  if (!Number.isFinite(lighting.lightmapScale) || lighting.lightmapScale <= 0) {
    throw new Error("Invalid baked lightmap scale.");
  }
  const modelUrl = new URL(bakedUrl + "Sponza.gltf", document.baseURI);
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
  const ao = new Texture(bakedUrl + "ao.png", activeScene, true, false);
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
  if (!meshes.length) throw new Error("Sponza contains no renderable meshes.");
  let minimum = new Vector3(Infinity, Infinity, Infinity);
  let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    mesh.receiveShadows = true;
    const bounds = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
    maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
  }
  const center = minimum.add(maximum).scale(0.5);
  const width = maximum.x - minimum.x;
  const eye = minimum.y + 1.7;
  const resetFlight = attachFlyControls(camera, canvas);
  function resetView() {
    resetFlight();
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
    const positions: Record<string, Vector3> = {
      atrium: new Vector3(minimum.x + width * 0.16, eye, center.z),
      reverse: new Vector3(maximum.x - width * 0.16, eye, center.z),
      upper: new Vector3(minimum.x + width * 0.23, minimum.y + (maximum.y - minimum.y) * 0.65, center.z),
    };
    camera.position.copyFrom(positions[view.value]);
    camera.setTarget(new Vector3(center.x, eye + 0.5, center.z));
  }
  function updateSunDirection() {
    const azimuth = Number(sunAzimuth.value) * Math.PI / 180;
    const elevation = Number(sunElevation.value) * Math.PI / 180;
    sun.direction.set(-Math.cos(elevation) * Math.cos(azimuth), -Math.sin(elevation), -Math.cos(elevation) * Math.sin(azimuth));
    sun.position.copyFrom(center.subtract(sun.direction.scale(Vector3.Distance(minimum, maximum))));
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
  renderTask.objectList = { meshes, particleSystems: [] };
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
      shadowTask.shadowGenerator!.contactHardeningLightSizeUVRatio = 0.005;
      volume.lightingVolume.frequency = 0;
      frameGraph.pausedExecution = false;
    });
    return graphBuild;
  }
  function updateShadows() {
    const size = Number(shadows.value);
    shadowTask.mapSize = size || 1024;
    shadowTask.disabled = volume.disabled = shafts.disabled = !size;
    renderTask.shadowGenerators = size ? [shadowTask] : [];
    activeScene.shadowsEnabled = size !== 0;
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
  shadows.addEventListener("change", () => {
    updateShadows();
    void rebuildGraph().catch(fail);
  });
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
