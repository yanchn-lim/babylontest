const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4193/comparison.html';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const report = await page.evaluate(async sofaUrl => {
      const B = await import('/node_modules/.vite/deps/@babylonjs_core.js');
      const { prepareScene } = await import('/src/apartment/prepare-scene.ts');
      const { geometry } = await import('/src/comparison/surface-geometry.ts');
      const engine = new B.Engine(document.createElement('canvas'), false);
      const scene = new B.Scene(engine);
      scene.useRightHandedSystem = true;
      const settings = { fixtures: [], views: {}, sky: [1, 1, 1] };
      const material = new B.PBRMaterial('Metallic texture regression', scene);
      material.albedoColor = new B.Color3(.8, .6, .4);
      material.metallic = 1;
      material.useMetallnessFromMetallicTextureBlue = true;
      const texture = B.RawTexture.CreateRGBATexture(new Uint8Array([
        255, 30, 0, 255, 0, 30, 128, 255, 0, 30, 255, 255, 0, 30, 0, 255,
      ]), 4, 1, scene, false, false, B.Texture.NEAREST_SAMPLINGMODE);
      texture.gammaSpace = false;
      texture.coordinatesIndex = 1;
      material.metallicTexture = texture;
      const mesh = new B.Mesh('Receiver', scene);
      mesh.material = material;
      mesh.setVerticesData('position', [0, 0, 0, 1, 0, 0, 0, 1, 0]);
      mesh.setVerticesData('normal', [0, 0, 1, 0, 0, 1, 0, 0, 1]);
      mesh.setVerticesData('uv', [0, 0, 0, 0, 0, 0]);
      mesh.setVerticesData('uv3', [.1, .1, .9, .1, .1, .9]);
      mesh.setIndices([0, 1, 2]);
      const checks = [];
      async function check(name, u, expected) {
        mesh.setVerticesData('uv2', [u, .5, u, .5, u, .5]);
        const data = await prepareScene([mesh], [material], settings);
        const surface = geometry(data).surfaces;
        const actual = Array.from(surface.slice((64 * 256 + 64) * 12 + 8, (64 * 256 + 64) * 12 + 11));
        if (actual.some((v, i) => Math.abs(v - expected[i]) > 1e-6)) throw Error(name + ': ' + actual + ' expected ' + expected);
        checks.push({ name, actual });
      }
      const base = [.8, .6, .4], diffuse = value => base.map(v => v * value);
      await check('Nonmetal texture restores diffuse', .125, base);
      await check('Linear partial metal', .375, diffuse(1 - 128 / 255));
      await check('Full metal remains without diffuse', .625, [0, 0, 0]);
      material.metallic = .5;
      await check('Scalar multiplies metallic texel', .375, diffuse(1 - .5 * 128 / 255));
      material.metallic = 1;
      texture.uOffset = -.5;
      await check('Metallic uses its own UV set and transform', .625, base);
      texture.uOffset = 0;
      texture.wrapU = B.Texture.MIRROR_ADDRESSMODE;
      await check('Mirrored negative UV', -.625, [0, 0, 0]);
      texture.wrapU = B.Texture.CLAMP_ADDRESSMODE;
      await check('Clamped edge UV', 1.5, base);
      material.useMetallnessFromMetallicTextureBlue = false;
      await check('Babylon red metallic channel', .125, [0, 0, 0]);
      material.metallicTexture = null;
      material.metallic = .25;
      await check('Scalar-only material unchanged', .125, diffuse(.75));
      mesh.dispose(); material.dispose(); texture.dispose();
      let sofa;
      if (sofaUrl) {
        const loaded = await B.SceneLoader.ImportMeshAsync('', '', sofaUrl, scene, undefined, '.glb');
        const meshes = loaded.meshes.filter(mesh => mesh.getTotalVertices() > 0);
        const materials = [...new Set(meshes.map(mesh => mesh.material))];
        const count = meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0), columns = Math.ceil(Math.sqrt(count));
        let face = 0;
        for (const mesh of meshes) {
          mesh.convertToUnIndexedMesh();
          const atlas = [];
          // Separate triangle charts isolate material handling from the site's overlapping atlas.
          for (let i = 0; i < mesh.getTotalVertices(); i += 3, face++) {
            const x = face % columns, y = Math.floor(face / columns);
            atlas.push((x + .15) / columns, (y + .15) / columns, (x + .85) / columns, (y + .15) / columns,
              (x + .15) / columns, (y + .85) / columns);
          }
          mesh.setVerticesData('uv3', atlas);
        }
        const data = await prepareScene(meshes, materials, settings);
        const before = structuredClone(data);
        before.materials.forEach((m, i) => {
          m.color = materials[i].albedoColor.scale(1 - (materials[i].metallic ?? 0)).asArray();
          delete m.metallicTexture;
        });
        function stats(data) {
          const surfaces = geometry(data).surfaces;
          let samples = 0, positive = 0, sum = 0;
          for (let i = 0; i < surfaces.length; i += 12) if (surfaces[i + 3]) {
            const color = surfaces[i + 8] + surfaces[i + 9] + surfaces[i + 10];
            samples++; positive += color > 0; sum += color / 3;
          }
          return { samples, positive, meanDiffuse: sum / samples };
        }
        sofa = { triangles: count, before: stats(before), after: stats(data) };
        if (sofa.before.positive !== 0 || sofa.after.positive < sofa.after.samples * .9) throw Error('Sofa diffuse regression: ' + JSON.stringify(sofa));
      }
      scene.dispose(); engine.dispose();
      return { checks, sofa };
    }, process.env.SOFA_MODEL_URL || null);
    assert.deepEqual(errors, []);
    fs.mkdirSync('.tools/metallic-transfer', { recursive: true });
    fs.writeFileSync('.tools/metallic-transfer/report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
