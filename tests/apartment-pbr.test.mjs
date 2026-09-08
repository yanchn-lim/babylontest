import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../public/models/bukit-merah/", import.meta.url);
const read = name => readFileSync(new URL(name, root));
const source = JSON.parse(read("baked/Apartment.gltf"));
const model = JSON.parse(read("pbr/Apartment.gltf"));
const lighting = JSON.parse(read("pbr/lighting.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const changed = [0, 1, 2, 3, 4, 8, 10, 11];

test("PBR variant preserves geometry, baked UVs, ceiling, and unchanged glass and metal", () => {
  assert.deepEqual(model.nodes, source.nodes);
  assert.deepEqual(model.scenes, source.scenes);
  assert.equal(hash(read("pbr/" + model.buffers[0].uri)), hash(read("baked/" + source.buffers[0].uri)));
  for (let i = 0; i < source.meshes[0].primitives.length; i++) {
    const before = source.meshes[0].primitives[i];
    const after = model.meshes[0].primitives[i];
    assert.equal(after.indices, before.indices);
    for (const key of ["POSITION", "NORMAL", "TEXCOORD_1"]) {
      assert.equal(after.attributes[key], before.attributes[key]);
    }
    if (!changed.includes(before.material)) {
      assert.deepEqual(model.materials[before.material], source.materials[before.material]);
    }
  }
  assert.equal(lighting.ceilingIncluded, true);
});

test("PBR surface maps use UV0, valid normals, and metallic-roughness maps", () => {
  for (const index of changed) {
    const material = model.materials[index];
    const pbr = material.pbrMetallicRoughness;
    for (const info of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, material.normalTexture]) {
      assert.ok(info);
      assert.equal(info.texCoord ?? 0, 0);
      const image = model.images[model.textures[info.index].source];
      assert.ok(read("pbr/" + image.uri).length > 1000);
    }
    assert.equal(pbr.metallicFactor, 0);
    assert.ok(material.normalTexture.scale > 0 && material.normalTexture.scale <= 1);
  }
  for (const primitive of model.meshes[0].primitives) {
    if (!changed.includes(primitive.material)) continue;
    assert.equal(primitive.attributes.TANGENT, undefined);
    const accessor = model.accessors[primitive.attributes.TEXCOORD_0];
    const view = model.bufferViews[accessor.bufferView];
    const buffer = read("pbr/" + model.buffers[view.buffer].uri);
    assert.equal(accessor.count, model.accessors[primitive.attributes.POSITION].count);
    for (let i = 0; i < accessor.count * 2; i++) {
      assert.ok(Number.isFinite(buffer.readFloatLE((view.byteOffset ?? 0) + i * 4)));
    }
  }
});

test("PBR files match their hashes and retain the denoised bake provenance", () => {
  for (const [name, expected] of Object.entries(lighting.sha256)) assert.equal(hash(read("pbr/" + name)), expected);
  for (const image of model.images) assert.ok(read("pbr/" + image.uri).length > 0);
  for (const buffer of model.buffers) assert.equal(read("pbr/" + buffer.uri).length, buffer.byteLength);
  const png = read("pbr/indirect.png");
  assert.equal(png.readUInt32BE(16), 4096);
  assert.equal(png.readUInt32BE(20), 4096);
  assert.equal(lighting.materialRetint.sourceLightmapSha256, hash(read("baked/indirect.png")));
  assert.ok(lighting.lightmapScale > 0);
  const sources = JSON.parse(read("pbr/sources.json"));
  assert.equal(sources.license, "CC0-1.0");
  assert.equal(Object.keys(sources.assets).length, 4);
  assert.equal(Object.keys(sources.downloads).length, 12);
});

