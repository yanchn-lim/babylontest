import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes("/interior-lighting/") && specifier.startsWith("./") && !specifier.endsWith(".ts")) return next(specifier + ".ts", context);
  return next(specifier, context);
} });
const { solarPosition, singaporeDaylight, candela } = await import("../src/interior-lighting/solar.ts");
const { LightingController } = await import("../src/interior-lighting/controller.ts");
const { boxTriangles, buildBvh, packBvh } = await import("../src/interior-lighting/bvh.ts");

test("sun agrees with the NREL SPA reference case within 0.05 degrees", () => {
  const sun = solarPosition({ latitude: 39.742476, longitude: -105.1786, instant: "2003-10-17T12:30:30-07:00", northDegrees: 0 });
  assert.ok(Math.abs(sun.azimuth - 194.34024) < .05, String(sun.azimuth));
  // Reference zenith includes atmospheric refraction; geometric tolerance accounts for it.
  assert.ok(Math.abs(sun.elevation - (90 - 50.11162)) < .05, String(sun.elevation));
});
test("UTC offset, night, and north rotation are handled consistently", () => {
  const day = solarPosition(singaporeDaylight);
  const utc = solarPosition({ ...singaporeDaylight, instant: "2026-03-20T04:00:00Z" });
  assert.deepEqual(day, utc);
  assert.ok(day.elevation > 60);
  assert.ok(solarPosition({ ...singaporeDaylight, instant: "2026-03-20T00:00:00+08:00" }).elevation < 0);
  const rotated = solarPosition({ ...singaporeDaylight, northDegrees: 90 });
  assert.ok(Math.abs(rotated.toSun[0] + day.toSun[2]) < 1e-10);
  assert.ok(Math.abs(rotated.toSun[2] - day.toSun[0]) < 1e-10);
  assert.throws(() => solarPosition({ ...singaporeDaylight, instant: "2026-03-20T12:00:00" }));
});
test("luminous flux is conserved by the uniform-cone conversion", () => {
  assert.ok(Math.abs(candela(800) * 4 * Math.PI - 800) < 1e-8);
  assert.ok(Math.abs(candela(800, 60) * 2 * Math.PI * (1 - Math.cos(Math.PI / 6)) - 800) < 1e-8);
  assert.throws(() => candela(-1)); assert.throws(() => candela(800, 0));
});
const fixture = id => ({ id, kind: "spot", position: [1,2,1], rotation: [0,0,0], enabled: true, lumens: 800, kelvin: 3000, beamDegrees: 60 });
test("controller separates revisions and coalesces rapid transform bounds", () => {
  const c = new LightingController();
  c.addFixture(fixture("a")); assert.equal(c.consumeChanges().lighting, 1);
  c.setExposure(2); assert.equal(c.consumeChanges(), null);
  const old = { min: [0,0,0], max: [1,1,1] }, next = { min: [2,0,0], max: [3,1,1] };
  c.notifyFurnitureTransform("cabinet", old, next);
  c.notifyFurnitureTransform("cabinet", next, { min: [4,0,0], max: [5,1,1] });
  c.notifyMaterialChange("cabinet", next);
  const changes = c.consumeChanges();
  assert.equal(changes.geometry, 2); assert.equal(changes.material, 1); assert.equal(changes.lighting, 1);
  assert.deepEqual(changes.regions, [{ min: [0,0,0], max: [5,1,1] }]);
  assert.equal(changes.reset, false); assert.equal(c.consumeChanges(), null);
});
test("fixture limits reject overflow without changing state; returned fixtures are isolated", () => {
  const c = new LightingController();
  for (let i=0;i<8;i++) c.addFixture(fixture(String(i)));
  assert.throws(() => c.addFixture(fixture("overflow")));
  assert.equal(c.fixtures.length, 8);
  c.updateFixture("0", { enabled: false }); c.addFixture(fixture("replacement"));
  assert.equal(c.fixtures.filter(f => f.enabled).length, 8);
  c.fixtures[0].position[0] = 999;
  assert.equal(c.fixtures[0].position[0], 1);
  c.removeFixture("replacement");
  assert.throws(() => c.setQuality({ probes: 513 }));
});
test("BVH preserves triangles and encloses every descendant; packing matches GPU layout", () => {
  const source = boxTriangles([-1,-2,-3], [1,2,3], 7);
  const bvh = buildBvh(source);
  assert.equal(bvh.triangles.length, 12);
  const visit = i => {
    const n = bvh.nodes[i];
    if (n.count) {
      for (const t of bvh.triangles.slice(n.first,n.first+n.count)) for (const p of [t.a,t.b,t.c]) for(let a=0;a<3;a++) assert.ok(p[a]>=n.min[a] && p[a]<=n.max[a]);
    } else for (const child of [n.left,n.right]) { assert.ok(child>i); visit(child); }
  };
  visit(0);
  const packed = packBvh(bvh);
  assert.equal(packed.nodes.byteLength, bvh.nodes.length*48);
  assert.equal(new Uint32Array(packed.triangles)[12], 7);
  assert.deepEqual(source[0], boxTriangles([-1,-2,-3], [1,2,3], 7)[0]);
});
