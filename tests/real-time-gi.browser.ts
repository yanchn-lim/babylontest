import { GIRSMRenderPluginMaterial, PBRMaterial, type Engine, type Scene } from "@babylonjs/core";

export async function verifyRealtimeGI(scene: Scene, engine: Engine) {
  const output = document.createElement("pre");
  output.id = "gi-test-results";
  Object.assign(output.style, { position: "fixed", right: "8px", bottom: "8px",
    maxHeight: "45vh", overflow: "auto", background: "#101820", color: "white", padding: "12px", zIndex: "20" });
  document.body.append(output);
  const results: Record<string, unknown> = {};
  const control = (id: string) => document.getElementById(id) as HTMLInputElement;
  const saved = ["gi-mode", "sun-azimuth", "sun-elevation", "sun-intensity", "sun-warmth"]
    .map(id => [id, control(id).value]);
  const cycle = control("day-cycle").checked;
  const wait = async () => {
    for (let i = 0; i < 90; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  function set(id: string, value: string) {
    control(id).value = value;
    control(id).dispatchEvent(new Event("input"));
    control(id).dispatchEvent(new Event("change"));
  }
  function assert(value: boolean, label: string) {
    results[label] = value;
    if (!value) throw new Error(label);
  }
  const sourceMaterials = scene.meshes.map(mesh => mesh.material).filter(material =>
    material instanceof PBRMaterial && !material.name.startsWith("RSMCreate_")) as PBRMaterial[];
  const count = () => ({ textures: scene.textures.length, materials: scene.materials.length,
    targets: scene.customRenderTargets.length });
  async function sample() {
    await wait();
    const target = scene.textures.find(texture => texture.name === "GIRSMContribution");
    if (!target) throw new Error("GI output is unavailable: " + document.querySelector("#gi-status")?.textContent);
    const data = await target.readPixels();
    if (!data) throw new Error("Cannot read GI texture.");
    const pixels = Array.from(data as Float32Array);
    const rgb = pixels.filter((_, i) => i % 4 !== 3);
    assert(rgb.every(Number.isFinite), "finitePixels");
    return rgb;
  }
  const sum = (pixels: number[]) => pixels.reduce((a, b) => a + b, 0);
  try {
    control("day-cycle").checked = false;
    control("day-cycle").dispatchEvent(new Event("change"));
    set("gi-mode", "baked");
    await wait();
    const baked = sourceMaterials.map(material => material.lightmapTexture);
    set("sun-azimuth", "35"); set("sun-elevation", "35"); set("sun-intensity", "3"); set("sun-warmth", "0");
    await wait();
    const bakedPixels = new Uint8Array((await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight())).buffer);
    assert(bakedPixels.some(value => value > 0), "bakedCaptureNotEmpty");
    set("gi-mode", "realtime");
    const first = await sample(), firstEnergy = sum(first);
    assert(firstEnergy > 0, "nonzeroGI");
    assert(sourceMaterials.every((material, i) => !baked[i] || material.lightmapTexture === null), "bakedRemoved");
    const steady = count();
    const giBuffers = engine._uniformBuffers.filter(buffer => /RSM|gBuffer|geometry/i.test(buffer.name));
    assert(giBuffers.length > 0, "tracksGIBuffers");
    set("sun-azimuth", "215");
    const second = await sample(), secondEnergy = sum(second);
    const distribution = first.reduce((n, v, i) =>
      n + Math.abs(v / firstEnergy - second[i] / secondEnergy), 0);
    results.normalizedDistributionDifference = distribution;
    assert(Number.isFinite(distribution) && distribution > 0.05, "sunChangesDistribution");
    set("sun-azimuth", "35"); set("sun-intensity", "1.5");
    const dim = await sample();
    results.halfIntensityRatio = sum(dim) / firstEnergy;
    assert(Math.abs(sum(dim) / firstEnergy - 0.5) < 0.08, "intensityResponds");
    set("sun-intensity", "3"); set("sun-warmth", "1");
    const warm = await sample();
    const blue = (a: number[]) => a.reduce((n, v, i) => n + (i % 3 === 2 ? v : 0), 0);
    results.warmBlueRatio = blue(warm) / blue(first);
    assert(blue(warm) < blue(first) * 0.9, "colorResponds");
    set("sun-intensity", "0"); await wait();
    assert(sourceMaterials.every(material => {
      const plugin = material.pluginManager?.getPlugin(GIRSMRenderPluginMaterial.Name);
      return !(plugin instanceof GIRSMRenderPluginMaterial) || !plugin.isEnabled;
    }), "nightRemovesStaleGI");
    for (let i = 0; i < 3; i++) {
      set("gi-mode", "baked"); await wait();
      assert(sourceMaterials.every((material, i) => material.lightmapTexture === baked[i]), "bakedRestored");
      set("gi-mode", "realtime"); set("sun-intensity", "3"); await wait();
    }
    results.resourcesBefore = steady;
    results.resourcesAfter = count();
    assert(JSON.stringify(steady) === JSON.stringify(count()), "modeChangesKeepResourceCounts");
    const scaling = engine.getHardwareScalingLevel();
    engine.setHardwareScalingLevel(scaling * 1.2); engine.resize(); await sample();
    engine.setHardwareScalingLevel(scaling); engine.resize(); await sample();
    assert(JSON.stringify(steady) === JSON.stringify(count()), "resizeKeepsResourceCounts");
    set("gi-mode", "baked"); set("sun-warmth", "0"); await wait();
    const restoredPixels = new Uint8Array((await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight())).buffer);
    const pixelError = bakedPixels.reduce((n, v, i) => n + Math.abs(v - restoredPixels[i]), 0) / bakedPixels.length;
    results.bakedPixelMeanError = pixelError;
    assert(pixelError <= 1, "bakedAppearanceRestored");
    if (new URLSearchParams(location.search).has("gi-dispose")) {
      engine.stopRenderLoop();
      scene.dispose();
      results.remainingUniformBuffers = engine._uniformBuffers.length;
      results.remainingBufferNames = engine._uniformBuffers.map(buffer => buffer.name);
      assert(scene.textures.length === 0 && giBuffers.every(buffer => !engine._uniformBuffers.includes(buffer)), "sceneDisposesGIResources");
      engine.dispose();
    }
    output.textContent = "PASS\n" + JSON.stringify(results, null, 2);
  } catch (error) {
    output.textContent = "FAIL\n" + String(error) + "\n" + JSON.stringify(results, null, 2);
  } finally {
    if (scene.isDisposed) return;
    for (const [id, value] of saved) set(id, value);
    control("day-cycle").checked = cycle;
    control("day-cycle").dispatchEvent(new Event("change"));
  }
}
