import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildBvh, packBvh } from '../src/interior-lighting/bvh.ts';
for (const split of ['median', 'surface-area']) test(`apartment escape links preserve traversal and layout (${split})`, () => {
  const root = new URL('../public/models/bukit-merah/pbr/', import.meta.url);
  const model = JSON.parse(fs.readFileSync(new URL('Apartment.gltf', root)));
  const buffers = model.buffers.map(b => fs.readFileSync(new URL(b.uri, root)));
  function read(id) {
    const a = model.accessors[id], v = model.bufferViews[a.bufferView], b = buffers[v.buffer], size = a.type === 'VEC3' ? 3 : 1, bytes = a.componentType === 5123 ? 2 : 4;
    return Array.from({ length: a.count * size }, (_, i) => {
      const offset = (v.byteOffset || 0) + (a.byteOffset || 0) + Math.floor(i / size) * (v.byteStride || size * bytes) + i % size * bytes;
      return a.componentType === 5126 ? b.readFloatLE(offset) : bytes === 2 ? b.readUInt16LE(offset) : b.readUInt32LE(offset);
    });
  }
  const triangles = model.meshes.flatMap(m => m.primitives.flatMap(p => {
    const positions = read(p.attributes.POSITION), indices = read(p.indices), result = [];
    for (let i = 0; i < indices.length; i += 3) {
      const points = [0, 1, 2].map(k => { const j = indices[i + k] * 3; return [-positions[j], positions[j + 1], positions[j + 2]]; });
      result.push({ a: points[0], b: points[1], c: points[2], material: p.material });
    }
    return result;
  }));
  const bvh = buildBvh(triangles, split), packed = packBvh(bvh), words = new Uint32Array(packed.nodes);
  assert.equal(triangles.length, 2160); assert.equal(packed.nodes.byteLength, bvh.nodes.length * 48);
  for (const transmitting of [
    model.materials.map(m => m.alphaMode === 'BLEND'),
    model.materials.map(m => m.alphaMode !== 'BLEND'),
  ]) {
    const masked = new Uint32Array(packBvh(bvh, transmitting).nodes);
    function expectedFlags(index) {
      const n = bvh.nodes[index];
      const expected = n.count
        ? bvh.triangles.slice(n.first, n.first + n.count)
          .reduce((flags, t) => flags | (transmitting[t.material] ? 2 : 1), 0)
        : expectedFlags(n.left) | expectedFlags(n.right);
      assert.equal(masked[index * 12 + 11], expected);
      return expected;
    }
    assert.equal(expectedFlags(0), 3);
  }
  for (let trial = 0; trial < 100; trial++) {
    const included = index => trial === 0 || (Math.imul(index + 1, 7919) ^ Math.imul(trial, 104729)) % 7 !== 0;
    const expected = [], stack = [0];
    while (stack.length) { const index = stack.pop(), node = bvh.nodes[index]; expected.push(index); if (included(index) && !node.count) stack.push(node.left, node.right); }
    const actual = []; let index = 0;
    while (index !== 0xffffffff) {
      assert.ok(actual.length < bvh.nodes.length + 1, 'Escape links must terminate'); actual.push(index);
      const offset = index * 12, node = bvh.nodes[index];
      assert.equal(words[offset + 8], node.first); assert.equal(words[offset + 9], node.count);
      index = included(index) && !node.count ? words[offset + 7] : words[offset + 10];
    }
    assert.deepEqual(actual, expected);
  }
});
