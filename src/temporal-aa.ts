import {
  FrameGraphTAATask, Vector2,
  type DirectionalLight, type FrameGraph, type FrameGraphGeometryRendererTask,
  type FrameGraphTextureHandle,
} from "@babylonjs/core";

import { ThinTAAPostProcess } from "@babylonjs/core/PostProcesses/thinTAAPostProcess.js";

class GICompatibleTAA extends ThinTAAPostProcess {
  readonly jitter = new Vector2();

  protected override _nextJitterOffset(output = new Vector2()) {
    super._nextJitterOffset(output);
    this.jitter.copyFrom(output);
    return output;
  }
}

export function createTemporalAA(
  graph: FrameGraph, renderer: FrameGraphGeometryRendererTask,
  source: FrameGraphTextureHandle, sun: DirectionalLight, controls: HTMLElement,
) {
  const scene = graph.scene;
  const effect = new GICompatibleTAA("taa", scene);
  effect.camera = renderer.camera;
  effect.samples = 8;
  effect.factor = 0.15;
  effect.reprojectHistory = true;
  effect.clampHistory = true;
  effect.disableOnCameraMove = false;
  const task = new FrameGraphTAATask("taa", graph, effect);
  task.objectRendererTask = renderer;
  task.sourceTexture = source;
  task.velocityTexture = renderer.geometryLinearVelocityTexture;
  graph.addTask(task);

  // Babylon 9.25 exposes history reset only through this internal method.
  const reset = () => effect._reset();
  let lighting = "";
  const before = scene.onBeforeRenderTargetsRenderObservable.add(() => {
    const next = [sun.direction.x, sun.direction.y, sun.direction.z,
      sun.intensity, sun.diffuse.r, sun.diffuse.g, sun.diffuse.b].join(",");
    if (next !== lighting) { reset(); lighting = next; }
  });
  controls.addEventListener("input", reset);
  controls.addEventListener("change", reset);
  scene.onDisposeObservable.add(() => {
    scene.onBeforeRenderTargetsRenderObservable.remove(before);
    controls.removeEventListener("input", reset);
    controls.removeEventListener("change", reset);
  });
  return { task, jitter: effect.jitter, reset };
}
