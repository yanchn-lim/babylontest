import assert from "node:assert/strict";
import { test } from "node:test";
import { daylightAt, advanceDay, attachDayNight } from "../src/day-night.ts";

test("daylight fades direct sun at the horizon and ambient light at night", () => {
  assert.equal(daylightAt(12).sun, 1);
  assert.equal(daylightAt(12).ambient, 1);
  assert.equal(daylightAt(0).sun, 0);
  assert.equal(daylightAt(0).ambient, 0.015);
  assert.equal(daylightAt(6).sun, 0);
  assert.ok(daylightAt(6.5).warmth > daylightAt(12).warmth);
  assert.ok(daylightAt(18).ambient > daylightAt(0).ambient);
  for (let hour = 0; hour <= 24; hour += 0.01) {
    const state = daylightAt(hour);
    assert.ok(Object.values(state).every(Number.isFinite));
    for (const key of ["sun", "ambient", "sky", "warmth"]) assert.ok(state[key] >= 0 && state[key] <= 1);
    if (state.elevation <= 0) assert.equal(state.sun, 0);
  }
});

test("clock wraps at midnight and advances equally at different frame rates", () => {
  assert.equal(advanceDay(23, 60, 24), 0);
  assert.equal(advanceDay(4, 300, 5), 4);
  assert.equal(advanceDay(4, -1, 5), 4);
  for (const fps of [30, 60, 120]) {
    let hour = 14;
    for (let i = 0; i < fps * 10; i++) hour = advanceDay(hour, 1 / fps, 5);
    assert.ok(Math.abs(hour - 14.8) < 1e-9);
  }
  for (const key of ["sun", "ambient", "sky", "warmth", "elevation"]) {
    assert.ok(Math.abs(daylightAt(0)[key] - daylightAt(24)[key]) < 1e-10);
  }
});

test("playback starts paused, stops when disabled, and does not advance while hidden or rebuilding", () => {
  const ids = ["day-cycle", "day-time", "day-length", "day-play", "day-time-value", "day-length-value",
    "sun-azimuth", "sun-elevation", "sun-warmth", "day-phase"];
  const elements = new Map(ids.map(id => {
    const element = new EventTarget();
    Object.assign(element, { value: "", checked: false, disabled: false, setAttribute() {} });
    return ["#" + id, element];
  }));
  const time = elements.get("#day-time"), enabled = elements.get("#day-cycle");
  time.value = "12"; enabled.checked = true; elements.get("#day-length").value = "5";
  const original = globalThis.document, originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, querySelector: id => elements.get(id), querySelectorAll: () => [] });
  const cycle = attachDayNight();
  try {
    cycle.tick(0, false); cycle.tick(1000, false);
    assert.equal(time.value, "12");
    elements.get("#day-play").dispatchEvent(new Event("click"));
    cycle.tick(2000, false); cycle.tick(2200, false);
    assert.ok(Number(time.value) > 12);
    const pausedTime = time.value;
    cycle.tick(3000, true);
    document.hidden = true; cycle.tick(4000, false);
    assert.equal(time.value, pausedTime);
    enabled.checked = false; enabled.dispatchEvent(new Event("change"));
    assert.equal(cycle.playing, false);
    assert.equal(cycle.sample(), null);
    assert.equal(elements.get("#sun-azimuth").disabled, false);
  } finally {
    cycle.dispose();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});
