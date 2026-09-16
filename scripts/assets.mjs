import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const environmentRevision = "8be9384c7f8728cb45d27975ac92a412f97a98dd";
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

await download(environmentBase + "/environments/environmentSpecular.dds", "environments/environmentSpecular.dds");
await download(environmentBase + "/LICENSE", "LICENSES/BabylonAssets.txt");
await writeFile(path.join(root, "ASSET-SOURCES.json"), JSON.stringify({
  environment: { repository: environmentBase, revision: environmentRevision }
}, null, 2) + "\n");

console.log("Apartment environment and attribution downloaded. Apartment assets are included in the project.");
