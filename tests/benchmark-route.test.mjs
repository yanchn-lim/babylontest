import assert from "node:assert/strict";
import { test } from "node:test";
import { MeshBuilder, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { createWalkingRoute, WALK_ROUTE } from "../src/benchmark-route.ts";

function simulate(fps, withWall = false) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new UniversalCamera("route", new Vector3(0, 1.65, 0), scene);
  camera.inputs.clear();
  camera.inertia = 0;
  camera.checkCollisions = withWall;
  camera.ellipsoid.set(0.2, 0.75, 0.2);
  if (withWall) {
    const wall = MeshBuilder.CreateBox("wall", { width: 100, height: 4, depth: 0.2 }, scene);
    wall.position.set(0, 2, 2);
    wall.checkCollisions = true;
    wall.computeWorldMatrix(true);
  }
  const advance = createWalkingRoute(camera);
  try {
    for (let i = 0; i < fps * 7.5; i++) { advance(1 / fps); camera.update(); }
    return { position: camera.position.clone(), yaw: camera.rotation.y };
  } finally { scene.dispose(); engine.dispose(); }
}

test("walking benchmark integrates the same free-space route at different frame rates", () => {
  const slow = simulate(30), fast = simulate(120);
  assert.ok(slow.position.equalsWithEpsilon(fast.position, 1e-6));
  assert.ok(Math.abs(slow.yaw - fast.yaw) < 1e-6);
  const radius = WALK_ROUTE.speed / WALK_ROUTE.turnRate;
  assert.ok(Math.abs(slow.position.x - radius) < 1e-6);
  assert.ok(Math.abs(slow.position.z - radius) < 1e-6);
  assert.equal(slow.position.y, 1.65);
});

test("walking benchmark uses Babylon collisions and slides along a wall", () => {
  const result = simulate(120, true);
  assert.ok(result.position.z > 1.5 && result.position.z < 1.71);
  assert.ok(result.position.x > 2);
  assert.ok(Math.abs(result.position.y - 1.65) < 1e-6);
});
