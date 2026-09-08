import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sponzaRevision = "723ffc6706725b618b8c14ceb82e3e6904b08a76";
const environmentRevision = "8be9384c7f8728cb45d27975ac92a412f97a98dd";
const modelBase = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/" + sponzaRevision;
const environmentBase = "https://raw.githubusercontent.com/BabylonJS/Assets/" + environmentRevision;
const root = path.resolve("public");

async function download(url, relativePath) {
  const destination = path.resolve(root, relativePath);
  if (!destination.startsWith(root + path.sep)) throw new Error("Asset path escapes public directory.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ": HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return bytes;
}

const modelBytes = await download(modelBase + "/Models/Sponza/glTF/Sponza.gltf", "models/sponza/Sponza.gltf");
const model = JSON.parse(modelBytes.toString());
const uris = [...new Set([...model.buffers, ...model.images].map(item => item.uri))];
let downloaded = 0;
const queue = [...uris];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const uri = queue.shift();
    if (!uri || uri.startsWith("data:")) continue;
    await download(modelBase + "/Models/Sponza/glTF/" + uri, "models/sponza/" + uri);
    downloaded++;
    if (downloaded % 10 === 0) console.log("Downloaded " + downloaded + "/" + uris.length + " assets");
  }
}));
await download(modelBase + "/Models/Sponza/README.md", "models/sponza/SOURCE.md");
await download(modelBase + "/LICENSES/LicenseRef-CRYENGINE-Agreement.txt", "LICENSES/Sponza.txt");
await download(environmentBase + "/environments/environmentSpecular.dds", "environments/environmentSpecular.dds");
await download(environmentBase + "/LICENSE", "LICENSES/BabylonAssets.txt");
await writeFile(path.join(root, "ASSET-SOURCES.json"), JSON.stringify({
  sponza: { repository: modelBase, revision: sponzaRevision },
  environment: { repository: environmentBase, revision: environmentRevision }
}, null, 2) + "\n");

for (const buffer of model.buffers) {
  const bytes = await readFile(path.join(root, "models/sponza", buffer.uri));
  if (bytes.length !== buffer.byteLength) throw new Error("Incorrect model buffer length: " + buffer.uri);
}
console.log("Sponza, " + model.images.length + " textures, environment, and attribution downloaded.");
