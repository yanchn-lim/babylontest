const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4189/comparison.html';
const out = '.tools/offset-study';
fs.mkdirSync(out, { recursive: true });

// Central texels avoid chart padding and isolate the closed cavity from its edges.
function facePixels(mesh, axis, sign) {
  const uv = [];
  for (let i = 0; i < mesh.normals.length / 3; i++) {
    if (mesh.normals[i * 3 + axis] * sign > .99) uv.push(mesh.uvs.slice(i * 2, i * 2 + 2));
  }
  const lo = [0, 1].map(k => Math.min(...uv.map(v => v[k])));
  const hi = [0, 1].map(k => Math.max(...uv.map(v => v[k])));
  const pixels = [];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    if ([x, y].every((v, k) => (v + .5) / 256 >= lo[k] * .75 + hi[k] * .25
      && (v + .5) / 256 <= lo[k] * .25 + hi[k] * .75)) pixels.push(y * 256 + x);
  }
  assert.ok(pixels.length);
  return pixels;
}
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

(async () => {
  const { offsetStudy } = await import('../src/comparison/offset-study.ts');
  const base = JSON.parse(fs.readFileSync('public/comparison/scene.json'));
  const data = offsetStudy(base, false), cavity = facePixels(data.meshes[8], 1, 1);
  const table = facePixels(data.meshes[2], 1, 1), back = facePixels(data.meshes[3], 2, 1);
  const results = [], errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
    const settle = () => page.waitForFunction(() => window.comparison?.ready && comparison.state().activeGi === 'transfer'
      && !comparison.state().transfer.updating, {}, { timeout: 120000 });
    for (const density of ['coarse', 'dense']) {
      const target = new URL(url);
      target.search = new URLSearchParams({ study: 'offsets', density, offset: 'fixed', lighting: 'indirect', hour: '9' });
      await page.goto(target.href);
      for (const offsets of ['fixed', 'adaptive']) {
        await page.selectOption('#offset-mode', offsets); await settle();
        const pixels = await page.evaluate(async () => {
          const texture = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
          return Array.from(await texture.readPixels());
        });
        assert.ok(pixels.every(value => Number.isFinite(value) && value >= 0));
        const raw = zlib.gunzipSync(fs.readFileSync(`public/comparison/offset-study/${density}-${offsets}/transfer.bin.gz`));
        const visibility = new Float32Array(raw.buffer, raw.byteOffset + 64 + 65537 * 4, 65536 * 4);
        const sky = mean(cavity.map(i => visibility[i * 4]));
        const lamp = mean(cavity.map(i => visibility[i * 4 + 1]));
        if (offsets === 'adaptive') { assert.equal(sky, 0, 'Closed gap leaks sky'); assert.equal(lamp, 0, 'Closed gap leaks lamp light'); }
        else assert.ok(lamp > .9, 'Fixed-offset control must reproduce the thin-gap leak');
        const luminance = ids => mean(ids.map(i => .2126 * pixels[i * 4] + .7152 * pixels[i * 4 + 1] + .0722 * pixels[i * 4 + 2]));
        results.push({ density, offsets, sky, lamp, table: luminance(table), back: luminance(back), state: await page.evaluate(() => comparison.state()) });
        await page.locator('canvas').screenshot({ path: `${out}/${density}-${offsets}.png` });
      }
    }
    const adaptive = results.filter(result => result.offsets === 'adaptive');
    for (const part of ['table', 'back']) {
      const difference = Math.abs(adaptive[1][part] - adaptive[0][part]) / adaptive[0][part];
      assert.ok(difference < .05, `${part} changed ${(difference * 100).toFixed(2)}% with tessellation`);
    }
    await page.selectOption('#lighting-view', 'full');
    await page.locator('#time').evaluate(e => { e.value = '21'; e.dispatchEvent(new Event('input')); }); await settle();
    assert.equal(await page.evaluate(() => comparison.state().on), true);
    await page.locator('canvas').screenshot({ path: `${out}/dense-adaptive-night.png` });
    const revision = await page.evaluate(() => comparison.state().transfer.revision);
    await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
    await page.waitForTimeout(150); await page.keyboard.up('KeyW');
    assert.equal(await page.evaluate(() => comparison.state().transfer.revision), revision);
    // Existing caches must still load after adding the opt-in shader variant.
    await page.goto(url); await settle();
    assert.equal(await page.evaluate(() => comparison.state().offsetStudy), null);
    assert.ok(await page.evaluate(() => comparison.state().reference));
    await page.goto(new URL('apartment.html', url).href);
    await page.waitForFunction(() => window.apartment?.ready && apartment.state().activeGi === 'transfer'
      && !apartment.state().transfer.updating, {}, { timeout: 120000 });
    assert.equal(await page.evaluate(() => apartment.state().transfer.entries), 5152669);
    const fallback = await browser.newPage();
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await fallback.goto(url + '?study=offsets');
    await fallback.waitForFunction(() => window.comparison?.ready);
    assert.match(await fallback.locator('#status').innerText(), /requires WebGPU/);
    await fallback.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${out}/report.json`, JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
