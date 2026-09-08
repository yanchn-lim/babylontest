import assert from "node:assert/strict";
import { test } from "node:test";
import { NullEngine, Scene, FrameGraph, FrameGraphBloomTask, Constants } from "@babylonjs/core";
import { imageProcessingPixelShader } from "@babylonjs/core/Shaders/imageProcessing.fragment.js";
import { BloomToneMappingTask, addBloomToImageProcessing } from "../src/bloom-tone-mapping.ts";

test("bloom is added before native image processing, with a guarded disabled path", () => {
  const original = imageProcessingPixelShader.shader;
  const fused = addBloomToImageProcessing("fragment", original);
  assert.ok(fused.includes("if(bloomWeight>0.)"));
  assert.ok(fused.indexOf("result.rgb+=") < fused.indexOf("result.rgb=max"));
  assert.ok(fused.includes("result=applyImageProcessing(result);"));
  assert.equal(addBloomToImageProcessing("vertex", original), original);
  assert.throws(() => addBloomToImageProcessing("fragment", "changed shader"), /needs review/);
});

test("fusion retains blur dependencies and skips merge/copy passes after rebuilds", async () => {
  const engine = new NullEngine(), scene = new Scene(engine), graph = new FrameGraph(scene);
  // This test validates graph recording; NullEngine cannot allocate WebGL textures.
  graph.textureManager._allocateTextures = () => {};
  graph.textureManager.createRenderTarget = () => ({ dispose() {} });
  const source = graph.textureManager.createRenderTargetTexture("hdr", {
    size: 64, options: { types: [Constants.TEXTURETYPE_HALF_FLOAT], formats: [Constants.TEXTUREFORMAT_RGBA] },
  });
  const bloom = new FrameGraphBloomTask("test-bloom", graph, 0.12, 32, 1, false, 0.5);
  bloom.sourceTexture = source;
  bloom.targetTexture = source;
  graph.addTask(bloom);
  const tone = new BloomToneMappingTask("test-fused-tone", graph, bloom);
  tone.sourceTexture = source;
  graph.addTask(tone);
  try {
    for (const disabled of [false, true, false]) {
      bloom.disabled = disabled;
      await graph.buildAsync(false);
      assert.equal(bloom.passes.find(pass => pass.name === "test-bloom Merge").disabled, true);
      assert.equal(bloom.passes.filter(pass => !pass.disabled).length, 3);
      assert.ok(bloom.passesDisabled.every(pass => pass.disabled));
      const blur = bloom.passes.find(pass => pass.name === "test-bloom Blur Y");
      const dependencies = new Set();
      tone.passes[0].collectDependencies(dependencies);
      assert.ok(dependencies.has(blur.renderTarget));
      assert.ok(dependencies.has(source));
    }
  } finally { graph.dispose(); scene.dispose(); engine.dispose(); }
});

test("fused bloom avoids allocating an unused full-resolution HDR output", async () => {
  const width = 2556, height = 849;
  async function allocation(alias) {
    const engine = new NullEngine(), scene = new Scene(engine), graph = new FrameGraph(scene);
    graph.textureManager._allocateTextures = tasks => {
      if (tasks) graph.textureManager._optimizeTextureAllocation(tasks);
    };
    graph.textureManager.createRenderTarget = () => ({ dispose() {} });
    const texture = (name, type) => graph.textureManager.createRenderTargetTexture(name, {
      size: { width, height }, options: { types: [type], formats: [Constants.TEXTUREFORMAT_RGBA] },
    });
    const source = texture("hdr", Constants.TEXTURETYPE_HALF_FLOAT);
    const bloom = new FrameGraphBloomTask("bloom", graph, 0.12, 32, 1, true, 0.5);
    bloom.sourceTexture = source;
    if (alias) bloom.targetTexture = source;
    graph.addTask(bloom);
    const tone = new BloomToneMappingTask("tone", graph, bloom);
    tone.sourceTexture = source;
    tone.targetTexture = texture("display", Constants.TEXTURETYPE_UNSIGNED_BYTE);
    graph.addTask(tone);
    try {
      await graph.buildAsync(false);
      return graph.textureManager.computeTotalTextureSize(true, width, height);
    } finally { graph.dispose(); scene.dispose(); engine.dispose(); }
  }
  assert.equal(await allocation(false) - await allocation(true), width * height * 8);
});
