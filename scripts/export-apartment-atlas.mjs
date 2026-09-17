// Use the same surface partition as the viewer before packing its lighting UVs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mesh, NullEngine, Scene } from '@babylonjs/core';
import { partitionSurfaceMeshes } from '../src/interior-lighting/surface-partition.ts';

const source = new URL('../public/models/bukit-merah/pbr/', import.meta.url);
const model = JSON.parse(fs.readFileSync(new URL('Apartment.gltf', source)));
const buffers = model.buffers.map(buffer => fs.readFileSync(new URL(buffer.uri, source)));
function read(index) {
  const accessor = model.accessors[index], view = model.bufferViews[accessor.bufferView];
  const size = { SCALAR: 1, VEC3: 3 }[accessor.type], bytes = accessor.componentType === 5123 ? 2 : 4;
  return Array.from({ length: accessor.count * size }, (_, i) => {
    const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0)
      + Math.floor(i / size) * (view.byteStride || size * bytes) + i % size * bytes;
    const buffer = buffers[view.buffer];
    return accessor.componentType === 5126 ? buffer.readFloatLE(offset)
      : bytes === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
  });
}
const engine = new NullEngine(), scene = new Scene(engine);
try {
  const meshes = model.meshes[0].primitives.map(primitive => {
    const mesh = new Mesh('Atlas source', scene);
    mesh.setVerticesData('position', read(primitive.attributes.POSITION));
    mesh.setVerticesData('normal', read(primitive.attributes.NORMAL));
    mesh.setIndices(read(primitive.indices));
    return mesh;
  });
  partitionSurfaceMeshes(meshes);
  const output = new URL('../.tools/apartment-atlas-input.json', import.meta.url);
  fs.mkdirSync(new URL('../.tools/', import.meta.url), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(meshes.map(mesh => ({
    positions: Array.from(mesh.getVerticesData('position')), normals: Array.from(mesh.getVerticesData('normal')),
    indices: Array.from(mesh.getIndices()),
  }))));
  console.log(fileURLToPath(output));
} finally { scene.dispose(); engine.dispose(); }
