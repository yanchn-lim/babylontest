import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

test("direction atlas matches the baked color and contains valid signed incoming-light moments", () => {
  const root = new URL("../public/models/bukit-merah/pbr/", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("lighting.json", root)));
  assert.equal(metadata.directional.referenceLightmapSha256, metadata.sha256["indirect.png"]);
  assert.equal(metadata.directional.space, "glTF model");
  assert.equal(metadata.directional.samples, 1024);
  assert.equal(metadata.currentMaterialBake.normalDetail, "runtime only");
  const png = readFileSync(new URL("direction.png", root));
  assert.equal(png.readUInt32BE(16), 4096);
  assert.equal(png.readUInt32BE(20), 4096);
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const stride = 4096 * 3 + 1;
  assert.equal(pixels.length, stride * 4096);
  let directional = 0;
  for (let y = 0; y < 4096; y++) {
    assert.equal(pixels[y * stride], 0);
    for (let x = 0; x < 4096; x += 17) {
      const offset = y * stride + 1 + x * 3;
      const length = Math.hypot(...Array.from(pixels.subarray(offset, offset + 3), v => v / 255 * 2 - 1));
      assert.ok(length <= 1.015);
      if (length > 0.1) directional++;
    }
  }
  assert.ok(directional > 1000);
});
