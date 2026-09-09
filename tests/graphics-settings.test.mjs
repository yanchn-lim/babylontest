import assert from "node:assert/strict";
import { test } from "node:test";
import { attachGraphicsPreferences, balancedLighting, graphicsDefaults } from "../src/graphics-settings.ts";

test("lighting preset persists its values without changing or notifying graphics quality", () => {
  const controls = new Map(Object.entries(graphicsDefaults).map(([id, value]) => {
    const control = new EventTarget();
    Object.assign(control, { id, type: typeof value === "boolean" ? "checkbox" : "range",
      tagName: "INPUT", min: "0", max: "10000", value: String(value), checked: value === true });
    if (typeof value === "string" && !Number.isFinite(Number(value))) {
      Object.assign(control, { type: "select-one", tagName: "SELECT", options: [{ value }] });
    }
    return [id, control];
  }));
  let stored = JSON.stringify({ ...graphicsDefaults, shadows: "4096", scale: "0.75",
    "sun-azimuth": "120", exposure: "2.2", "baked-intensity": "0.6" });
  const documentBefore = globalThis.document, storageBefore = globalThis.localStorage;
  globalThis.document = { getElementById: id => controls.get(id) };
  globalThis.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  try {
    const preferences = attachGraphicsPreferences();
    assert.equal(preferences.snapshot().exposure, "2.2");
    assert.equal(preferences.snapshot()["baked-intensity"], "0.6");
    const events = [];
    for (const [id, control] of controls) control.addEventListener("change", () => events.push(id));
    preferences.balanceLighting();
    const saved = JSON.parse(stored);
    for (const [id, value] of Object.entries(balancedLighting)) assert.equal(saved[id], value);
    assert.equal(saved.shadows, "4096");
    assert.equal(saved.scale, "0.75");
    assert.equal(saved["sun-azimuth"], "120");
    assert.deepEqual(events.sort(), ["baked-intensity", "exposure"]);
    preferences.balanceLighting();
    assert.equal(events.length, 2);
    preferences.dispose();
  } finally {
    if (documentBefore === undefined) delete globalThis.document; else globalThis.document = documentBefore;
    if (storageBefore === undefined) delete globalThis.localStorage; else globalThis.localStorage = storageBefore;
  }
});
