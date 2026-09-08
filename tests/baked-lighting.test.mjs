import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../public/models/sponza/", import.meta.url);
const baked = new URL("baked/", root);
const read = (name, base = baked) => readFileSync(new URL(name, base));
const source = JSON.parse(read("Sponza.gltf", root));
const model = JSON.parse(read("Sponza.gltf"));
const lighting = JSON.parse(read("lighting.json"));
const hash = data => createHash("sha256").update(data).digest("hex");

test("bake preserves materials, triangle count, and source references", () => {
  assert.deepEqual(model.materials, source.materials);
  const triangles = gltf => gltf.meshes.flatMap(mesh => mesh.primitives)
    .reduce((count, primitive) => count + gltf.accessors[primitive.indices].count / 3, 0);
  assert.equal(triangles(model), triangles(source));
  assert.equal(lighting.sourceSha256, hash(read("Sponza.gltf", root)));
  for (const image of model.images) assert.ok(existsSync(new URL(image.uri, baked)));
  for (const buffer of model.buffers) assert.equal(read(buffer.uri).length, buffer.byteLength);
});

test("baked UVs are finite and contained in the atlas", () => {
  const buffers = model.buffers.map(buffer => read(buffer.uri));
  for (const primitive of model.meshes.flatMap(mesh => mesh.primitives)) {
    const accessor = model.accessors[primitive.attributes.TEXCOORD_1];
    assert.ok(accessor);
    assert.equal(accessor.type, "VEC2");
    assert.equal(accessor.componentType, 5126);
    assert.equal(accessor.count, model.accessors[primitive.attributes.POSITION].count);
    const view = model.bufferViews[accessor.bufferView];
    const buffer = buffers[view.buffer];
    for (let i = 0; i < accessor.count; i++) {
      const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 8);
      for (let component = 0; component < 2; component++) {
        const uv = buffer.readFloatLE(offset + component * 4);
        assert.ok(Number.isFinite(uv) && uv >= -0.00001 && uv <= 1.00001);
      }
    }
  }
  assert.ok(lighting.statistics.uvAreaCoverage >= 0.2);
});

test("bake outputs match their hashes and texture dimensions", () => {
  for (const [name, expected] of Object.entries(lighting.sha256)) assert.equal(hash(read(name)), expected);
  for (const name of ["ao.png", "indirect.png"]) {
    const png = read(name);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), lighting.resolution);
    assert.equal(png.readUInt32BE(20), lighting.resolution);
  }
  assert.ok(lighting.statistics.indirectPeak > 0);
  assert.ok(lighting.lightmapScale > 0);
});


test("baked lighting is independent of the movable sun", () => {
  assert.equal(lighting.samples, 512);
  assert.equal(lighting.includesDiffuseSky, true);
  assert.equal(lighting.includesSunBounce, false);
  assert.deepEqual(lighting.sky.passes, ["DIRECT", "INDIRECT", "COLOR"]);
  assert.equal(lighting.statistics.sunIndirectMean, 0);
  assert.ok(lighting.statistics.skyMean > 0);
  const sum = lighting.statistics.sunIndirectMean + lighting.statistics.skyMean;
  assert.ok(Math.abs(lighting.statistics.indirectMean - sum) < 0.00001);
});
