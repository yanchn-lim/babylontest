import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NullEngine, Scene, FrameGraph, Observable,
  UniversalCamera, DirectionalLight, Vector3, Matrix,
} from "@babylonjs/core";
import { createTemporalAA } from "../src/temporal-aa.ts";

test("TAA shares jitter without changing the camera and resets stale lighting history", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const graph = new FrameGraph(scene);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  const renderer = {
    camera, geometryLinearVelocityTexture: 1,
    objectRenderer: { onInitRenderingObservable: new Observable() },
  };
  const sun = new DirectionalLight("sun", Vector3.Down(), scene);
  const controls = new EventTarget();
  const taa = createTemporalAA(graph, renderer, 0, sun, controls);
  try {
    const effect = taa.task.postProcess;
    effect.textureWidth = 1280;
    effect.textureHeight = 720;
    const original = camera.getProjectionMatrix().clone();
    effect._updateJitter();
    const offset = Matrix.Translation(taa.jitter.x, taa.jitter.y, 0);
    const point = new Vector3(1, 2, 10);
    const plain = Vector3.TransformCoordinates(point, original);
    const shifted = Vector3.TransformCoordinates(point, original.multiply(offset));
    assert.ok(Math.abs(shifted.x - plain.x - taa.jitter.x) < 1e-6);
    assert.ok(Math.abs(shifted.y - plain.y - taa.jitter.y) < 1e-6);
    assert.ok(original.equals(camera.getProjectionMatrix()));

    let resets = 0;
    effect._reset = () => { resets++; };
    const frame = () => scene.onBeforeRenderTargetsRenderObservable.notifyObservers(scene);
    frame();
    const initial = resets;
    frame();
    assert.equal(resets, initial, "static lighting keeps history");
    sun.intensity = 0; frame();
    assert.equal(resets, initial + 1, "night discards daytime history");
    sun.direction.x = 1; frame();
    sun.diffuse.r = 0.5; frame();
    assert.equal(resets, initial + 3, "direction and color discard old history");
    controls.dispatchEvent(new Event("input"));
    assert.equal(resets, initial + 4);
    scene.dispose();
    const disposed = resets;
    controls.dispatchEvent(new Event("change"));
    assert.equal(resets, disposed, "disposal removes control listeners");
  } finally {
    graph.dispose();
    if (!scene.isDisposed) scene.dispose();
    engine.dispose();
  }
});
