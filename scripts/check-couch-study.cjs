const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4194/comparison.html';
const out = '.tools/couch-study';

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], results = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const settle = () => page.waitForFunction(() => window.comparison?.ready && comparison.state().activeGi === 'transfer'
      && !comparison.state().transfer.updating, {}, { timeout: 120000 });
    await page.goto(url + '?study=couch&lights=on');
    await settle();
    assert.equal(await page.locator('#metallic-control').isVisible(), true);
    const native = await page.evaluate(() => comparison.scene.meshes.filter(m => m.name.startsWith('ProcessedMeshNode')).map(m => ({
      triangles: m.getTotalIndices() / 3, albedo: !!m.material.albedoTexture, metallic: !!m.material.metallicTexture,
    })));
    assert.equal(native.reduce((sum, m) => sum + m.triangles, 0), 1982);
    assert.ok(native.every(m => m.albedo && m.metallic));
    for (const mode of ['corrected', 'legacy']) {
      const camera = await page.evaluate(() => comparison.camera.position.asArray());
      await page.selectOption('#metallic-mode', mode); await settle();
      assert.deepEqual(await page.evaluate(() => comparison.camera.position.asArray()), camera);
      for (const lighting of ['full', 'indirect']) {
        await page.selectOption('#lighting-view', lighting); await settle();
        await page.locator('canvas').screenshot({ path: `${out}/${mode}-${lighting}.png` });
      }
      const mean = await page.evaluate(async () => {
        const texture = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
        const pixels = await texture.readPixels();
        let sum = 0, count = 0;
        // Only the couch occupies the right half of the atlas.
        for (let y = 0; y < 256; y++) for (let x = 124; x < 250; x++) {
          const i = (y * 256 + x) * 4;
          if (![pixels[i], pixels[i + 1], pixels[i + 2]].every(Number.isFinite)) throw Error('Nonfinite GI');
          sum += pixels[i] + pixels[i + 1] + pixels[i + 2]; count += 3;
        }
        return sum / count;
      });
      results.push({ mode, mean, state: await page.evaluate(() => comparison.state()) });
    }
    assert.ok(results[0].mean > .001, 'Corrected couch must receive diffuse GI');
    assert.equal(results[1].mean, 0, 'Before-fix couch must reproduce zero diffuse GI');
    await page.selectOption('#metallic-mode', 'corrected'); await settle();
    await page.selectOption('#lighting-view', 'full');
    await page.locator('[data-hour="21"][data-on="true"]').click(); await settle();
    assert.equal(await page.evaluate(() => comparison.state().on), true);
    await page.selectOption('#view', 'doorway');
    await page.locator('canvas').screenshot({ path: `${out}/corrected-night-close.png` });
    const revision = await page.evaluate(() => comparison.state().transfer.revision);
    await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
    await page.waitForTimeout(150); await page.keyboard.up('KeyW');
    assert.equal(await page.evaluate(() => comparison.state().transfer.revision), revision);
    await page.goto(url); await settle();
    assert.equal(await page.evaluate(() => comparison.state().couchStudy), null);
    assert.ok(await page.evaluate(() => comparison.state().reference));
    const fallback = await browser.newPage();
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await fallback.goto(url + '?study=couch');
    await fallback.waitForFunction(() => window.comparison?.ready);
    assert.match(await fallback.locator('#status').innerText(), /requires WebGPU/);
    await fallback.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${out}/report.json`, JSON.stringify({ native, results, errors }, null, 2));
    console.log(JSON.stringify({ native, results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
