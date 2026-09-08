import assert from "node:assert/strict";
import { test } from "node:test";
import { NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { attachFlyControls } from "../src/fly-controls.ts";

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera("test", Vector3.Zero(), scene);
  camera.inputs.clear();
  let delta = 1000 / 60;
  engine.getDeltaTime = () => delta;
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const document = new EventTarget();
  class Element extends EventTarget {
    style = {};
    classList = { add() {}, remove() {} };
    focus() {
      if (document.activeElement === this) return;
      document.activeElement = this;
      const event = new Event("focusin");
      Object.defineProperty(event, "target", { value: this });
      document.dispatchEvent(event);
    }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 124, height: 124 }; }
  }
  const canvas = new Element();
  const nodes = Object.fromEntries(["move-stick", "stick-thumb", "capture-mouse", "fly-up", "fly-down"].map(id => [id, new Element()]));
  document.querySelector = selector => nodes[selector.slice(1)];
  document.pointerLockElement = null;
  globalThis.document = document;
  globalThis.window = new EventTarget();
  const reset = attachFlyControls(camera, canvas);
  canvas.focus();
  function send(target, type, data = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, ...data });
    target.dispatchEvent(event);
  }
  return {
    camera, canvas, nodes, reset, send, document,
    frame(ms = 1000 / 60) { delta = ms; scene.onBeforeRenderObservable.notifyObservers(scene); },
    close() {
      scene.dispose();
      engine.dispose();
      globalThis.document = oldDocument;
      globalThis.window = oldWindow;
    },
  };
}

test("keyboard flight is frame-rate independent, normalized, and boosted by Shift", () => {
  const f = fixture();
  try {
    f.send(f.canvas, "keydown", { code: "KeyW" });
    for (let i = 0; i < 60; i++) f.frame();
    assert.ok(Math.abs(f.camera.position.z - 3) < 1e-6);
    f.camera.position.setAll(0);
    for (let i = 0; i < 30; i++) f.frame(1000 / 30);
    assert.ok(Math.abs(f.camera.position.z - 3) < 1e-6);
    f.camera.position.setAll(0);
    f.send(f.canvas, "keydown", { code: "KeyD" });
    f.frame();
    assert.ok(Math.abs(f.camera.position.length() - 0.05) < 1e-6);
    f.camera.position.setAll(0);
    f.send(f.canvas, "keydown", { code: "ShiftLeft" });
    f.frame();
    assert.ok(Math.abs(f.camera.position.length() - 0.15) < 1e-6);
  } finally { f.close(); }
});

test("vertical flight and release, blur, and focus changes stop movement", () => {
  const f = fixture();
  try {
    f.send(f.canvas, "keydown", { code: "KeyE" });
    f.frame();
    assert.ok(f.camera.position.y > 0);
    f.send(window, "keyup", { code: "KeyE" });
    const stopped = f.camera.position.clone();
    f.frame();
    assert.ok(f.camera.position.equals(stopped));
    for (const stop of [
      () => f.send(window, "blur"),
      () => f.send(f.document, "visibilitychange"),
      () => f.nodes["capture-mouse"].focus(),
      () => f.reset(),
    ]) {
      f.canvas.focus();
      f.send(f.canvas, "keydown", { code: "KeyW" });
      stop();
      const position = f.camera.position.clone();
      f.frame();
      assert.ok(f.camera.position.equals(position));
    }
  } finally { f.close(); }
});

test("mobile movement, looking, and ascent work together and cancel independently", () => {
  const f = fixture();
  try {
    f.send(f.nodes["move-stick"], "pointerdown", { pointerId: 1, clientX: 62, clientY: 0 });
    f.send(f.canvas, "pointerdown", { pointerId: 2, clientX: 200, clientY: 100 });
    f.send(f.canvas, "pointermove", { pointerId: 2, clientX: 220, clientY: 90 });
    f.send(f.nodes["fly-up"], "pointerdown", { pointerId: 3 });
    f.frame();
    assert.ok(f.camera.position.z > 0);
    assert.ok(f.camera.position.y > 0);
    assert.ok(f.camera.rotation.y > 0);
    f.send(f.nodes["move-stick"], "pointercancel", { pointerId: 1 });
    f.send(f.nodes["fly-up"], "lostpointercapture", { pointerId: 3 });
    f.send(f.canvas, "pointercancel", { pointerId: 2 });
    const stopped = f.camera.position.clone();
    const rotation = f.camera.rotation.clone();
    f.send(f.canvas, "pointermove", { pointerId: 2, clientX: 300, clientY: 200 });
    f.frame();
    assert.ok(f.camera.position.equals(stopped));
    assert.ok(f.camera.rotation.equals(rotation));
  } finally { f.close(); }
});

test("look is pitch-clamped and long frames cannot teleport the camera", () => {
  const f = fixture();
  try {
    f.send(f.canvas, "pointerdown", { pointerId: 1, clientX: 0, clientY: 0 });
    f.send(f.canvas, "pointermove", { pointerId: 1, clientX: 0, clientY: 100000 });
    assert.ok(f.camera.rotation.x < Math.PI / 2);
    f.send(f.canvas, "keydown", { code: "KeyW" });
    f.frame(10000);
    assert.ok(f.camera.position.length() <= 0.150001);
  } finally { f.close(); }
});
