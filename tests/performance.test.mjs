import assert from "node:assert/strict";
import { test } from "node:test";
import { NullEngine, Scene, UniversalCamera, Vector3, DirectionalLight, ShadowGenerator, FrameGraph, FrameGraphShadowGeneratorTask } from "@babylonjs/core";
import { ShadowCache, createRebuildQueue, summarizeFrames, BenchmarkRun } from "../src/performance.ts";
import { bindSurfaceShadow } from "../src/shadow-binding.ts";
import { graphicsDefaults, validPreference } from "../src/graphics-settings.ts";

test("cached shadows retain their map and invalidate without tying updates to the camera", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const graph = new FrameGraph(scene);
  const task = new FrameGraphShadowGeneratorTask("test-shadows", graph);
  const cache = new ShadowCache();
  const map = { pixels: 0 };
  task.passes.push({ _execute() { map.pixels++; } });
  task.passesDisabled.push({ _execute() {} });
  let revision = null;
  task.onAfterTaskExecute.add(() => { if (!task.disabled) cache.complete(revision); });
  function frame(enabled = true) {
    revision = cache.begin(enabled);
    task.disabled = revision === null;
    task._execute();
  }
  frame();
  for (let i = 0; i < 120; i++) frame();
  assert.equal(map.pixels, 1);
  // Sun/caster/configuration changes invalidate the same retained resource.
  cache.invalidate(); frame();
  assert.equal(map.pixels, 2);
  cache.invalidate(); frame(false);
  assert.equal(map.pixels, 2);
  assert.equal(cache.dirty, true);
  frame();
  assert.equal(map.pixels, 3);
  const old = cache.begin(true);
  cache.invalidate();
  cache.complete(old);
  assert.equal(cache.dirty, true);
  task.dispose(); graph.dispose(); scene.dispose(); engine.dispose();
});

test("surface binding overrides both lookup slots after creating a volume generator", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  const light = new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
  const surface = new ShadowGenerator(1024, light);
  const volume = new ShadowGenerator(512, light);
  bindSurfaceShadow(light, camera, surface);
  assert.equal(light.getShadowGenerator(camera), surface);
  assert.equal(light.getShadowGenerator(), surface);
  assert.equal(volume.mapSize, 512);
  volume.dispose(); surface.dispose(); scene.dispose(); engine.dispose();
});

test("rebuild queue coalesces bursts, serializes in-flight changes, and retries failures", async () => {
  let calls = 0, release;
  const queue = createRebuildQueue(async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
  });
  const first = queue();
  assert.equal(queue(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  queue(); queue();
  release();
  await first;
  assert.equal(calls, 2);
  let attempts = 0;
  const recover = createRebuildQueue(async () => { if (++attempts === 1) throw new Error("build failed"); });
  await assert.rejects(recover(), /build failed/);
  await recover();
  assert.equal(attempts, 2);
});

test("benchmark excludes warmup, includes a slow final frame, and handles empty data", () => {
  const run = new BenchmarkRun(0);
  run.sample(14990);
  run.sample(15010);
  assert.equal(run.frames.length, 0);
  run.sample(15030, 8);
  assert.deepEqual(run.frames, [20]);
  assert.deepEqual(run.gpu, [8]);
  run.sample(74990);
  assert.equal(run.sample(75040), true);
  assert.equal(run.frames.at(-1), 50);
  assert.equal(summarizeFrames([]), null);
  const result = summarizeFrames([10, 20, 30, 40, NaN, -1]);
  assert.equal(result.medianMs, 25);
  assert.equal(result.p95Ms, 40);
  assert.equal(result.over33Percent, 25);
});

test("shared graphics settings validate inputs and exclude scene and navigation", () => {
  assert.equal(graphicsDefaults["shadow-method"], "pcf");
  assert.equal(graphicsDefaults.shadows, "1024");
  assert.equal(graphicsDefaults["shadow-filter"], "low");
  for (const id of ["scene-select", "view", "navigation"]) assert.equal(graphicsDefaults[id], undefined);
  assert.equal(validPreference({ type: "checkbox" }, "false"), false);
  assert.equal(validPreference({ type: "checkbox" }, false), true);
  const range = { type: "range", tagName: "INPUT", min: "0", max: "1" };
  for (const value of ["", "NaN", "Infinity", "-1", "2", {}, null]) assert.equal(validPreference(range, value), false);
  assert.equal(validPreference(range, "0.5"), true);
  assert.equal(validPreference({ type: "select-one", tagName: "SELECT", options: [{ value: "pcf" }] }, "pcss"), false);
});

test("caster tracking ignores camera movement but catches transforms and visibility", async () => {
  const { MeshBuilder } = await import("@babylonjs/core");
  const { trackShadowCasters } = await import("../src/shadow-binding.ts");
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  const states = new Map();
  assert.equal(trackShadowCasters([mesh], states), true);
  camera.position.x = 2;
  scene.incrementRenderId();
  assert.equal(trackShadowCasters([mesh], states), false);
  mesh.position.x = 1;
  scene.incrementRenderId();
  assert.equal(trackShadowCasters([mesh], states), true);
  assert.equal(trackShadowCasters([mesh], states), false);
  mesh.isVisible = false;
  assert.equal(trackShadowCasters([mesh], states), true);
  mesh.setEnabled(false);
  assert.equal(trackShadowCasters([mesh], states), true);
  scene.dispose(); engine.dispose();
});
