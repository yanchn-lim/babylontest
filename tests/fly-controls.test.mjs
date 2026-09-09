import assert from "node:assert/strict";
import { test } from "node:test";
import { MeshBuilder, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { attachFlyControls } from "../src/fly-controls.ts";

test("touch walking continues when a settings field gains focus, and release stops it", () => {
  const f = fixture(true);
  try {
    f.send(f.nodes["move-stick"], "pointerdown", { pointerId: 1, clientX: 62, clientY: 0 });
    f.send(f.canvas, "keydown", { code: "KeyD" });
    f.nodes["capture-mouse"].focus();
    f.frame();
    assert.ok(f.camera.position.z > 0);
    assert.equal(f.camera.position.x, 0);
    f.send(f.nodes["move-stick"], "pointerup", { pointerId: 1 });
    const stopped = f.camera.position.clone();
    f.frame();
    assert.ok(f.camera.position.equals(stopped));
  } finally { f.close(); }
});

function fixture(walking = false) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera("test", Vector3.Zero(), scene);
  camera.inputs.clear();
  camera.inertia = 0;
  camera.ellipsoid.set(0.2, 0.75, 0.2);
  camera.ellipsoidOffset.set(0, -0.14, 0);
  camera.checkCollisions = walking;
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
  const reset = attachFlyControls(camera, canvas, () => walking);
  canvas.focus();
  function send(target, type, data = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, ...data });
    target.dispatchEvent(event);
  }
  return {
    camera, canvas, nodes, reset, send, document, scene,
    setWalking(value) { reset(); walking = value; camera.checkCollisions = value; },
    frame(ms = 1000 / 60) {
      delta = ms;
      scene.onBeforeRenderObservable.notifyObservers(scene);
      if (walking) camera.update();
    },
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


test("walking stays at eye height, ignores pitch and ascent, and is frame-rate independent", () => {
  const f = fixture(true);
  try {
    f.camera.position.set(0, 1.65, 0);
    f.camera.rotation.x = 0.8;
    f.send(f.canvas, "keydown", { code: "KeyW" });
    f.send(f.canvas, "keydown", { code: "KeyE" });
    for (let i = 0; i < 60; i++) f.frame();
    assert.ok(Math.abs(f.camera.position.z - 1.8) < 1e-5);
    assert.ok(Math.abs(f.camera.position.y - 1.65) < 1e-5);
    f.camera.position.set(0, 1.65, 0);
    for (let i = 0; i < 30; i++) f.frame(1000 / 30);
    assert.ok(Math.abs(f.camera.position.z - 1.8) < 1e-5);
    f.setWalking(false);
    f.send(f.canvas, "keydown", { code: "KeyE" });
    f.frame();
    assert.ok(f.camera.position.y > 1.65);
  } finally { f.close(); }
});

test("Babylon walking collisions stop at walls, slide sideways, and allow doorways", () => {
  const f = fixture(true);
  try {
    const wall = MeshBuilder.CreateBox("wall", { width: 4, height: 3, depth: 0.1 }, f.scene);
    wall.position.set(0, 1.5, 1.5);
    wall.checkCollisions = true;
    wall.computeWorldMatrix(true);
    f.camera.position.set(0, 1.65, 0);
    f.send(f.canvas, "keydown", { code: "KeyW" });
    for (let i = 0; i < 120; i++) f.frame();
    assert.ok(f.camera.position.z > 1.15 && f.camera.position.z < 1.3);
    f.send(f.canvas, "keydown", { code: "KeyD" });
    for (let i = 0; i < 20; i++) f.frame();
    assert.ok(f.camera.position.x > 0.3);
    assert.ok(f.camera.position.z < 1.3);
    wall.dispose();
    for (const x of [-0.9, 0.9]) {
      const jamb = MeshBuilder.CreateBox("jamb", { width: 1, height: 3, depth: 0.1 }, f.scene);
      jamb.position.set(x, 1.5, 1.5);
      jamb.checkCollisions = true;
      jamb.computeWorldMatrix(true);
    }
    f.reset();
    f.camera.position.set(0, 1.65, 0);
    f.send(f.canvas, "keydown", { code: "KeyW" });
    for (let i = 0; i < 120; i++) f.frame();
    assert.ok(f.camera.position.z > 3);
  } finally { f.close(); }
});

test("mobile walking supports simultaneous movement and look without vertical flight", () => {
  const f = fixture(true);
  try {
    f.send(f.nodes["move-stick"], "pointerdown", { pointerId: 1, clientX: 62, clientY: 0 });
    f.send(f.canvas, "pointerdown", { pointerId: 2, clientX: 200, clientY: 100 });
    f.send(f.canvas, "pointermove", { pointerId: 2, clientX: 220, clientY: 70 });
    f.send(f.nodes["fly-up"], "pointerdown", { pointerId: 3 });
    f.frame();
    assert.ok(f.camera.position.z > 0);
    assert.ok(Math.abs(f.camera.position.y - 1.65) < 1e-5);
    assert.ok(f.camera.rotation.y > 0);
    f.reset();
    const position = f.camera.position.clone();
    f.frame();
    assert.ok(f.camera.position.equals(position));
  } finally { f.close(); }
});
