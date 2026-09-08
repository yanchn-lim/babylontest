import {
  Color4, CubeTexture, DefaultRenderingPipeline, DirectionalLight, Engine,
  ImageProcessingConfiguration, PBRMaterial, Scene, SceneLoader,
  ShadowGenerator, Texture, UniversalCamera, Vector3,
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
  status.textContent = "Could not load the scene. Check the console and run the asset setup again.";
}

async function start() {
  engine = new Engine(canvas, false, { stencil: true });
  scene = new Scene(engine);
  const activeEngine = engine;
  const activeScene = scene;
  activeScene.clearColor = new Color4(0.16, 0.20, 0.26, 1);
  activeScene.environmentTexture = CubeTexture.CreateFromPrefilteredData(import.meta.env.BASE_URL + "environments/environmentSpecular.dds", activeScene);
  activeScene.environmentIntensity = 0.65;
  activeScene.imageProcessingConfiguration.toneMappingEnabled = true;
  activeScene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  const camera = new UniversalCamera("camera", new Vector3(0, 2, 0), activeScene);
  camera.minZ = 0.05;
  camera.maxZ = 250;
  camera.inputs.clear();
  camera.inertia = 0;

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), activeScene);
  sun.position = new Vector3(12, 22, 8);
  sun.intensity = 3;

  const pipeline = new DefaultRenderingPipeline("rendering", true, activeScene, [camera]);
  pipeline.fxaaEnabled = true;
  activeEngine.runRenderLoop(() => activeScene.render());
  const bakedUrl = import.meta.env.BASE_URL + "models/sponza/baked/";
  const response = await fetch(bakedUrl + "lighting.json");
  if (!response.ok) throw new Error("Could not load baked lighting metadata.");
  const lighting = await response.json();
  if (!Number.isFinite(lighting.lightmapScale) || lighting.lightmapScale <= 0) {
    throw new Error("Invalid baked lightmap scale.");
  }
  const result = await SceneLoader.ImportMeshAsync("", bakedUrl, "Sponza.gltf", activeScene);
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
  let shadowMap: ShadowGenerator | undefined;
  function updateShadows() {
    shadowMap?.dispose();
    shadowMap = undefined;
    const size = Number(shadows.value);
    if (!size) return;
    shadowMap = new ShadowGenerator(size, sun);
    shadowMap.usePercentageCloserFiltering = true;
    shadowMap.bias = 0.0005;
    shadowMap.normalBias = 0.02;
    for (const mesh of meshes) shadowMap.addShadowCaster(mesh, false);
  }
  function resize() {
    activeEngine.setHardwareScalingLevel(1 / (window.devicePixelRatio * Number(scale.value)));
    activeEngine.resize();
  }
  view.addEventListener("change", resetView);
  shadows.addEventListener("change", updateShadows);
  exposure.addEventListener("input", () => {
    activeScene.imageProcessingConfiguration.exposure = Number(exposure.value);
    document.querySelector<HTMLOutputElement>("#exposure-value")!.value = Number(exposure.value).toFixed(1);
  });
  fxaa.addEventListener("change", () => { pipeline.fxaaEnabled = fxaa.checked; });
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
  await activeScene.whenReadyAsync();
  controls.disabled = false;
  document.querySelector<HTMLElement>("#flight-controls")!.hidden = false;
  document.querySelector<HTMLButtonElement>("#capture-mouse")!.disabled = false;
  status.textContent = "Ready · " + meshes.length + " meshes";
  document.querySelector("#renderer")!.textContent = "WebGL " + activeEngine.webGLVersion;
  statistics = setInterval(() => {
    document.querySelector("#fps")!.textContent = activeEngine.getFps().toFixed(0) + " fps";
    document.querySelector("#frame")!.textContent = activeEngine.getDeltaTime().toFixed(1) + " ms";
    document.querySelector("#resolution")!.textContent = activeEngine.getRenderWidth() + " × " + activeEngine.getRenderHeight();
  }, 500);
}

void start().catch(fail);
if (import.meta.hot) import.meta.hot.dispose(() => {
  clearInterval(statistics);
  scene?.dispose();
  engine?.dispose();
});
