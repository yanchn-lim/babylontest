import {
  Constants, EventState, GIRSM, GIRSMManager, GIRSMRenderPluginMaterial,
  PBRMaterial, ReflectiveShadowMap,
  type AbstractMesh, type DirectionalLight, type Engine, type Material,
  type Observer, type RenderTargetTexture, type Scene,
} from "@babylonjs/core";

// Babylon 9.25 runs custom targets with FrameGraph, but skips the legacy
// geometry-buffer stage and onBeforeDrawPhase. Keep its GI implementation.
class FrameGraphGIManager extends GIRSMManager {
  ready = false;
  error: unknown;
  override recreateResources(disposeGeometryBufferRenderer = false) {
    this.ready = false;
    try {
      super.recreateResources(disposeGeometryBufferRenderer);
    } catch (error) {
      this.error = error;
    }
  }
  protected override _createPostProcesses() {
    super._createPostProcesses();
    this.ready = this.enable;
  }
}

export function attachRealtimeGI(
  scene: Scene, engine: Engine, sun: DirectionalLight, meshes: AbstractMesh[],
  setBaked: (baked: boolean) => void,
) {
  const mode = document.querySelector<HTMLSelectElement>("#gi-mode")!;
  const message = document.querySelector<HTMLElement>("#gi-status")!;
  const materials = [...new Set(meshes.map(mesh => mesh.material))]
    .filter((material): material is PBRMaterial => material instanceof PBRMaterial);
  const caps = engine.getCaps();
  const supported = engine.webGLVersion === 2 && caps.drawBuffersExtension
    && (caps.maxDrawBuffers ?? 0) >= 3 && caps.textureHalfFloatRender
    && caps.textureHalfFloatLinearFiltering && caps.textureFloat;
  let manager: FrameGraphGIManager | undefined;
  let rsm: ReflectiveShadowMap | undefined;
  let geometry: RenderTargetTexture | undefined;
  let draw: Observer<Scene> | undefined;
  let sampleTexture: Scene["textures"][number] | undefined;
  let clones: Material[] = [];
  let materialPairs: [PBRMaterial, PBRMaterial][] = [];
  let rsmBuffers: Engine["_uniformBuffers"] = [];
  let dimensions = "";
  let requested = false;
  let failed = false;
  let frames = 0;

  function detachGeometry() {
    if (!geometry) return;
    const index = scene.customRenderTargets.indexOf(geometry);
    if (index !== -1) scene.customRenderTargets.splice(index, 1);
    geometry = undefined;
  }
  function plugins(enabled: boolean) {
    for (const material of materials) {
      const plugin = material.pluginManager?.getPlugin(GIRSMRenderPluginMaterial.Name);
      if (plugin instanceof GIRSMRenderPluginMaterial) plugin.isEnabled = enabled;
    }
  }
  function fallback(error: unknown) {
    console.warn("Real-time GI unavailable:", error);
    failed = true;
    requested = false;
    mode.value = "baked";
    if (rsm) rsm.enable = false;
    detachGeometry();
    if (manager) manager.enable = false;
    plugins(false);
    setBaked(true);
    message.textContent = "Real-time GI unavailable: " +
      (error instanceof Error ? error.message : String(error)) + " Baked lighting is active.";
  }
  function create() {
    const previousMaterials = new Set(scene.materials);
    const previousTextures = new Set(scene.textures);
    const previousObservers = new Set(scene.onBeforeDrawPhaseObservable.observers);
    const previousTargets = new Set(scene.customRenderTargets);
    const previousBuffers = new Set(engine._uniformBuffers);
    rsm = new ReflectiveShadowMap(scene, sun, { width: 256, height: 256 });
    // 9.25 leaves the RSM scene UBO alive on disposal. Track only its new buffers.
    rsmBuffers = engine._uniformBuffers.filter(buffer => !previousBuffers.has(buffer));
    for (const mesh of meshes) rsm.addMesh(mesh);
    const target = scene.customRenderTargets.find(target => !previousTargets.has(target));
    if (!target) throw new Error("Babylon RSM target was not found.");
    materialPairs = materials.map(material => {
      const mesh = meshes.find(mesh => mesh.material === material)!;
      return [material, mesh.getMaterialForRenderPass(target.renderPassId)];
    }).filter((pair): pair is [PBRMaterial, PBRMaterial] => pair[1] instanceof PBRMaterial);
    clones = scene.materials.filter(material => !previousMaterials.has(material));
    // Lightmap and GI plugins must not feed the light's flux capture.
    for (const material of clones) {
      if (material instanceof PBRMaterial) material.lightmapTexture = null;
    }
    manager = new FrameGraphGIManager(scene, { width: 1, height: 1 },
      { width: 1, height: 1 }, 64, Constants.TEXTURETYPE_HALF_FLOAT);
    sampleTexture = scene.textures.find(texture =>
      !previousTextures.has(texture) && texture.name === "GIRSMSamples");
    draw = scene.onBeforeDrawPhaseObservable.observers.find(observer => !previousObservers.has(observer));
    if (!draw) throw new Error("Babylon GI draw hook was not found.");
    const gi = new GIRSM(rsm);
    gi.numSamples = 64;
    gi.radius = 0.1;
    gi.intensity = 0.1;
    manager.addGIRSM(gi);
    for (const material of materials) manager.addMaterial(material);
  }
  function select() {
    requested = mode.value === "realtime";
    if (requested && (!supported || failed)) {
      fallback(new Error(supported ? "Reload the page to retry." :
        "WebGL 2 with three render targets and floating-point textures is required."));
      return;
    }
    try {
      if (requested && !manager) create();
      if (rsm) rsm.enable = requested;
      if (!requested) {
        detachGeometry();
        if (manager) manager.enable = false;
      }
      plugins(false);
      setBaked(!requested);
      message.textContent = requested
        ? "Preparing real-time GI…"
        : "Baked indirect lighting. No real-time GI rendering cost.";
    } catch (error) { fallback(error); }
  }
  const before = scene.onBeforeRenderTargetsRenderObservable.add(() => {
    if (!requested || !manager || !rsm) return;
    try {
      if (manager.error) throw manager.error;
      const width = engine.getRenderWidth(), height = engine.getRenderHeight();
      const next = width + "x" + height;
      if (dimensions !== next) {
        detachGeometry();
        manager.enable = false;
        manager.setOutputDimensions({ width, height });
        manager.setGITextureDimensions({
          width: Math.max(1, Math.ceil(width / 4)), height: Math.max(1, Math.ceil(height / 4)),
        });
        dimensions = next;
      }
      manager.enable = true;
      // Paused graphs and zero sunlight must never display the previous GI.
      const active = !scene.frameGraph?.pausedExecution && sun.intensity > 0;
      rsm.enable = active;
      manager.pause = !active;
      if (!manager.ready || !active) {
        plugins(false);
        detachGeometry();
        message.textContent = active ? "Preparing real-time GI…" :
          "Real-time GI paused: no sunlight or renderer rebuilding. No previous bounce is displayed.";
        return;
      }
      const target = scene.geometryBufferRenderer?.getGBuffer();
      if (!target) throw new Error("Babylon geometry buffer was not created.");
      if (geometry !== target) {
        detachGeometry();
        geometry = target;
        geometry.renderList = meshes;
        scene.customRenderTargets.push(geometry);
      }
      rsm.updateLightParameters();
      // RSM clones textures as well as materials. Keep the existing look controls live.
      for (const [source, clone] of materialPairs) {
        clone.roughness = source.roughness;
        clone.metallic = source.metallic;
        if (source.bumpTexture && clone.bumpTexture) clone.bumpTexture.level = source.bumpTexture.level;
      }
    } catch (error) { fallback(error); }
  });
  const after = scene.onAfterRenderTargetsRenderObservable.add(() => {
    if (!requested || !manager?.ready || manager.pause || !draw || !geometry) return;
    try {
      draw.callback(scene, new EventState(-1));
      plugins(true);
      frames++;
      message.textContent = "Real-time sunlight bounce · 256² RSM · 64 samples · quarter-resolution GI. Fixed environment fill remains.";
    } catch (error) { fallback(error); }
  });
  const restored = engine.onContextRestoredObservable.add(() => { dimensions = ""; });
  mode.addEventListener("change", select);
  select();
  scene.onDisposeObservable.add(() => {
    mode.removeEventListener("change", select);
    scene.onBeforeRenderTargetsRenderObservable.remove(before);
    scene.onAfterRenderTargetsRenderObservable.remove(after);
    engine.onContextRestoredObservable.remove(restored);
    detachGeometry();
    plugins(false);
    if (manager) { manager.enable = false; manager.dispose(); }
    // Babylon 9.25 does not dispose its sample texture or RSM material clones.
    sampleTexture?.dispose();
    rsm?.dispose();
    for (const buffer of rsmBuffers) {
      if (engine._uniformBuffers.includes(buffer)) buffer.dispose();
    }
    for (const material of clones) material.dispose();
  });
  return { diagnostics: () => ({ giMode: requested ? "realtime" : "baked", giFrames: frames }) };
}
