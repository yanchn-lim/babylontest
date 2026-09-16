const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.APARTMENT_URL || 'http://127.0.0.1:4185/apartment.html';
const out = path.resolve('.tools/apartment-transfer');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [], results = [];
  const watch = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1150 } }); watch(page);
    await page.goto(url);
    await page.waitForFunction(() => window.apartment?.ready, {}, { timeout: 60000 });
    const settle = async () => {
      await page.waitForFunction(() => apartment.state().loadError || apartment.state().transfer?.error ||
        (apartment.state().activeGi === 'transfer' && !apartment.state().transfer.updating), {}, { timeout: 90000 });
      const state = await page.evaluate(() => apartment.state());
      assert.equal(state.loadError, ''); assert.equal(state.transfer.error, '');
      return state;
    };
    await settle();
    const pixels = () => page.evaluate(async () => {
      const texture = apartment.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
      return Array.from(await texture.readPixels());
    });
    const setHour = async hour => {
      await page.locator('#time').evaluate((e, h) => { e.value = String(h); e.dispatchEvent(new Event('input')); }, hour);
      return settle();
    };
    for (const hour of [9, 21]) {
      const state = await setHour(hour);
      assert.equal(state.on, hour === 21); assert.equal(state.transfer.completedBounces, 4);
      const values = await pixels();
      assert.ok(values.every(v => Number.isFinite(v) && v >= 0));
      assert.ok(values.some((v, i) => i % 4 !== 3 && v > 0));
      results.push(state);
      for (const view of ['living', 'hall', 'bedroom']) {
        await page.selectOption('#view', view);
        await page.locator('canvas').screenshot({ path: path.join(out, `${hour}-${view}.png`) });
      }
    }
    const four = await pixels();
    await page.selectOption('#bounces', '1'); await settle(); assert.notDeepEqual(await pixels(), four);
    await page.selectOption('#bounces', '4'); await settle(); assert.deepEqual(await pixels(), four);
    await page.selectOption('#lights', 'off'); assert.equal((await settle()).on, false);
    assert.notDeepEqual(await pixels(), four);
    await setHour(9); await page.selectOption('#lights', 'on'); assert.equal((await settle()).on, true);
    await page.selectOption('#lights', 'auto'); assert.equal((await settle()).on, false);
    await page.selectOption('#view', 'living');
    const before = await page.evaluate(() => ({ position: apartment.camera.position.asArray(), revision: apartment.state().transfer.revision }));
    await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
    await page.waitForTimeout(200); await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => ({ position: apartment.camera.position.asArray(), revision: apartment.state().transfer.revision }));
    assert.notDeepEqual(after.position, before.position); assert.equal(after.revision, before.revision);
    await page.close();
    const fallback = await browser.newPage(); watch(fallback);
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await fallback.goto(url); await fallback.waitForFunction(() => window.apartment?.ready, {}, { timeout: 60000 });
    assert.equal(await fallback.evaluate(() => apartment.state().activeGi), 'baked');
    assert.ok(await fallback.locator('#bounces').isDisabled());
    await fallback.locator('canvas').screenshot({ path: path.join(out, 'webgl-fallback.png') });
    await fallback.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
