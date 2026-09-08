import { EngineInstrumentation } from "@babylonjs/core";
import type { Engine, Scene, UniversalCamera } from "@babylonjs/core";
import { BenchmarkRun, summarizeFrames } from "./performance";
import { timeGpuTask } from "./gpu-task-timer";
import { createWalkingRoute, WALK_ROUTE } from "./benchmark-route";

export function attachBenchmark(engine: Engine, scene: Scene, camera: UniversalCamera,
  settings: () => Record<string, unknown>, isPaused: () => boolean, diagnostics: () => Record<string, unknown>) {
  const start = document.querySelector<HTMLButtonElement>("#benchmark-start")!;
  const stop = document.querySelector<HTMLButtonElement>("#benchmark-stop")!;
  const copy = document.querySelector<HTMLButtonElement>("#benchmark-copy")!;
  const mode = document.querySelector<HTMLSelectElement>("#benchmark-mode")!;
  const progress = document.querySelector<HTMLElement>("#benchmark-status")!;
  const hud = document.querySelector<HTMLElement>("#benchmark-hud")!;
  const output = document.querySelector<HTMLTextAreaElement>("#benchmark-results")!;
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
  const instrumentation = new EngineInstrumentation(engine);
  const gpuSupported = !!engine.getCaps().timerQuery;
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let run: BenchmarkRun | undefined;
  const taskName = import.meta.env.DEV ? new URLSearchParams(location.search).get("gpu-task") : null;
  const task = scene.frameGraph?.tasks.find(task => task.name === taskName);
  const taskTimer = task ? timeGpuTask(engine, task, () => !!run) : undefined;
  const gpuCounter = taskTimer?.counter ?? instrumentation.gpuFrameTimeCounter;
  let metadata: Record<string, unknown> = {};
  let initialSettings = "";
  let initialSize = "";
  let lastGpuCount = 0;
  let lastStatus = "";
  let sunChanges = 0;
  let distance = 0;
  let previousPosition = camera.position.clone();
  let previousRotation = camera.rotation.clone();
  let sunTrace: { elapsedMs: number; azimuth: string; elevation: string }[] = [];
  const dimensions = () => [engine.getRenderWidth(), engine.getRenderHeight()];
  const cameraState = () => ({ position: camera.position.asArray(), rotation: camera.rotation.asArray() });
  const view = document.querySelector<HTMLSelectElement>("#view")!;
  const navigation = document.querySelector<HTMLSelectElement>("#navigation")!;
  const automatedWalk = import.meta.env.DEV && new URLSearchParams(location.search).get("walk-route") === "turning";
  const advanceRoute = createWalkingRoute(camera);
  let routeSeconds = 0;
  const routeObserver = automatedWalk ? scene.onBeforeRenderObservable.add(() => {
    if (!run || isPaused()) return;
    const elapsed = Math.max(0, Math.min(60, (performance.now() - run.started - run.warmupMs) / 1000));
    advanceRoute(elapsed - routeSeconds);
    routeSeconds = elapsed;
  }) : null;

  function announce(message: string) {
    if (message === lastStatus) return;
    lastStatus = message;
    progress.textContent = hud.textContent = message;
  }
  function finish(reason: string, complete = false) {
    if (!run) return;
    const frameIntervals = summarizeFrames(run.frames);
    const gpu = summarizeFrames(run.gpu);
    const result = {
      ...metadata, complete, reason, finishedAt: new Date().toISOString(), diagnosticsEnd: diagnostics(),
      frameIntervals, gpuTiming: {
        scope: task?.name ?? "frame",
        status: !gpuSupported ? "unsupported" : gpu ? "available" : "invalid-or-unavailable",
        samples: gpu?.samples ?? 0, medianMs: gpu?.medianMs ?? null, p95Ms: gpu?.p95Ms ?? null,
      },
      sunChanges, sunTrace, distanceTravelled: distance, cameraEnd: cameraState(),
      meetsWalkingTarget: complete && mode.value === "walking" && distance > 0.1 && frameIntervals !== null
        ? frameIntervals.medianFps >= 59 && frameIntervals.p95Ms <= 20 && frameIntervals.over33Percent < 1 : null,
    };
    output.value = JSON.stringify(result, null, 2);
    output.hidden = false;
    copy.disabled = false;
    instrumentation.captureGPUFrameTime = false;
    run = undefined;
    start.disabled = false;
    stop.disabled = true;
    mode.disabled = false;
    announce(frameIntervals
      ? `${complete ? "Complete" : "Stopped"}: ${frameIntervals.medianFps.toFixed(1)} fps median, ${frameIntervals.p95Ms.toFixed(1)} ms p95. ${reason}`
      : `Stopped: ${reason} No measured frames.`);
  }

  start.addEventListener("click", () => {
    if (run || isPaused() || !scene.isReady()) {
      announce("Wait for graphics to finish loading.");
      return;
    }
    if (automatedWalk && (mode.value !== "walking" || navigation.value !== "walk" || new URLSearchParams(location.search).get("scene") !== "bukit-merah")) {
      announce("The automated route requires the apartment, Walk navigation, and Manual walking test mode.");
      return;
    }
    routeSeconds = 0;
    const snapshot = settings();
    initialSettings = JSON.stringify(snapshot);
    initialSize = dimensions().join("x");
    run = new BenchmarkRun(performance.now());
    sunChanges = distance = 0;
    sunTrace = [];
    previousPosition.copyFrom(camera.position);
    previousRotation.copyFrom(camera.rotation);
    metadata = {
      version: 1, revision: __APP_REVISION__, startedAt: new Date().toISOString(),
      mode: mode.value, scene: new URLSearchParams(location.search).get("scene") || "sponza",
      walkingRoute: automatedWalk ? WALK_ROUTE : undefined,
      view: view.selectedOptions[0].textContent, navigation: navigation.value,
      settings: snapshot, dimensions: dimensions(), devicePixelRatio: window.devicePixelRatio,
      browser: navigator.userAgent, renderer: "WebGL " + engine.webGLVersion,
      cameraStart: cameraState(), diagnosticsStart: diagnostics(), warmupSeconds: 15, measurementSeconds: 60,
    };
    lastGpuCount = gpuCounter.count;
    instrumentation.captureGPUFrameTime = gpuSupported && !taskTimer;
    start.disabled = true;
    stop.disabled = false;
    mode.disabled = true;
    copy.disabled = true;
    output.hidden = true;
    announce(run.phase(performance.now()));
    dialog.close();
  }, options);
  stop.addEventListener("click", () => finish("Stopped by user."), options);
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(output.value); progress.textContent = "Results copied."; }
    catch { output.focus(); output.select(); progress.textContent = "Select and copy the results below."; }
  }, options);
  const changed = (event: Event) => {
    if (!run || !(event.target instanceof HTMLElement)) return;
    const id = event.target.id;
    if (id === "sun-azimuth" || id === "sun-elevation") {
      if (mode.value !== "moving-sun") { finish("Sun moved during a static-sun run."); return; }
      const snapshot = settings();
      if (JSON.stringify(snapshot) === initialSettings) return;
      sunTrace.push({ elapsedMs: performance.now() - run.started,
        azimuth: String(snapshot["sun-azimuth"]), elevation: String(snapshot["sun-elevation"]) });
      sunChanges++;
      initialSettings = JSON.stringify(snapshot);
      return;
    }
    if (JSON.stringify(settings()) !== initialSettings || id === "view" || id === "navigation") {
      finish("Settings or camera view changed; start a new run.");
    }
  };
  document.querySelector("#controls")!.addEventListener("input", changed, options);
  document.querySelector("#controls")!.addEventListener("change", changed, options);
  document.addEventListener("visibilitychange", () => { if (document.hidden) finish("Page became hidden."); }, options);
  const observer = engine.onEndFrameObservable.add(() => {
    if (!run) return;
    if (isPaused()) { finish("Graphics rebuilt; start a new run."); return; }
    if (dimensions().join("x") !== initialSize) { finish("Render dimensions changed."); return; }
    if (mode.value === "static" && (!camera.position.equalsWithEpsilon(previousPosition, 0.001) || !camera.rotation.equalsWithEpsilon(previousRotation, 0.001))) {
      finish("Camera moved during a stationary run."); return;
    }
    const now = performance.now();
    if (now >= run.started + run.warmupMs) distance += camera.position.subtract(previousPosition).length();
    previousPosition.copyFrom(camera.position);
    previousRotation.copyFrom(camera.rotation);
    const counter = gpuCounter;
    const gpuMs = counter.count > lastGpuCount && counter.current > 0 ? counter.current / 1e6 : undefined;
    lastGpuCount = counter.count;
    if (run.sample(now, gpuMs)) {
      finish(mode.value === "moving-sun" && !sunChanges ? "No sun movement recorded." : "60-second measurement finished.", true);
    } else announce(run.phase(now));
  });
  return () => {
    abort.abort();
    engine.onEndFrameObservable.remove(observer);
    scene.onBeforeRenderObservable.remove(routeObserver);
    taskTimer?.dispose();
    instrumentation.dispose();
  };
}
