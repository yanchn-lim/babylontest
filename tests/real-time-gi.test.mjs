import assert from "node:assert/strict";
import { test } from "node:test";
import { NullEngine, Scene, DirectionalLight, Vector3 } from "@babylonjs/core";
import { attachRealtimeGI } from "../src/real-time-gi.ts";

for (const modeValue of ["baked", "realtime"]) {
  test(`GI ${modeValue}: unsupported hardware retains baked lighting without allocations`, () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const mode = Object.assign(new EventTarget(), { value: modeValue });
    const message = { textContent: "" };
    const previous = globalThis.document;
    globalThis.document = { querySelector: id => id === "#gi-mode" ? mode : message };
    let baked;
    try {
      const textures = scene.textures.length;
      const gi = attachRealtimeGI(scene, engine, sun, [], value => { baked = value; });
      assert.equal(baked, true);
      assert.equal(mode.value, "baked");
      assert.equal(scene.textures.length, textures);
      assert.equal(gi.diagnostics().giMode, "baked");
      assert.match(message.textContent, modeValue === "realtime" ? /unavailable.*WebGL 2/ : /Baked indirect/);
      scene.dispose();
      baked = undefined;
      mode.dispatchEvent(new Event("change"));
      assert.equal(baked, undefined, "disposal removes the mode listener");
    } finally {
      if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
      engine.dispose();
    }
  });
}
