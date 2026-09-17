const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4185/comparison.html';
const out = '.tools/comparison-smoke';

(async () => {
  fs.mkdirSync(out, {recursive: true});
  const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu']});
  const errors = [], results = [];
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const watch = p => {
      p.on('pageerror', e => errors.push(e.message));
      p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    };
    watch(page);
    const settle = async () => {
      await page.waitForFunction(() => window.comparison?.ready && (comparison.state().transfer?.error ||
        (comparison.state().activeGi === 'transfer' && !comparison.state().transfer.updating)), {}, {timeout: 120000});
      assert.equal(await page.evaluate(() => comparison.state().transfer.error), '');
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    for (const study of ['room', 'couch', 'applaryd']) {
      const target = new URL(url); target.searchParams.set('study', study);
      await page.goto(target.href); await settle();
      assert.equal(await page.locator('#gi, #bounces, #metallic-mode, #offset-mode, #density, #lighting-view, #sphere-material').count(), 0);
      assert.deepEqual(await page.locator('#study option').evaluateAll(options => options.map(o => o.value)), ['room', 'couch', 'applaryd']);
      const state = await page.evaluate(() => comparison.state());
      assert.equal(state.transfer.completedBounces, 4);
      if (study === 'room') {
        assert.match(state.reference, /room-12-off.png$/);
        await page.selectOption('#layout', 'overlay');
        assert.equal(await page.locator('#blend-control').isVisible(), true);
        await page.selectOption('#layout', 'split');
      } else {
        const triangles = await page.evaluate(() => comparison.scene.meshes.filter(m => m.getVerticesData('uv3')).reduce((n, m) => n + m.getTotalIndices() / 3, 0));
        assert.equal(triangles, study === 'couch' ? 1982 : 7628);
        await page.selectOption('#view', 'doorway');
      }
      await page.locator('canvas').screenshot({path: `${out}/${study}-noon.png`});
      await page.selectOption('#lights', 'auto');
      await page.locator('#time').fill('21'); await page.locator('#time').dispatchEvent('input'); await settle();
      assert.equal(await page.evaluate(() => comparison.state().on), true);
      await page.selectOption('#lights', 'off'); await settle();
      assert.equal(await page.evaluate(() => comparison.state().on), false);
      await page.selectOption('#lights', 'on'); await settle();
      await page.locator('canvas').screenshot({path: `${out}/${study}-night.png`});
      const revision = await page.evaluate(() => comparison.state().transfer.revision);
      await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
      await page.waitForTimeout(150); await page.keyboard.up('KeyW');
      assert.equal(await page.evaluate(() => comparison.state().transfer.revision), revision);
      await page.click('#reset');
      results.push({study, state: await page.evaluate(() => comparison.state())});
    }
    const fallback = await browser.newPage(); watch(fallback);
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: undefined}));
    for (const study of ['room', 'applaryd']) {
      const target = new URL(url); target.searchParams.set('study', study);
      await fallback.goto(target.href); await fallback.waitForFunction(() => window.comparison?.ready);
      assert.equal(await fallback.evaluate(() => comparison.state().activeGi), 'baked');
      if (study === 'applaryd') assert.match(await fallback.locator('#status').innerText(), /direct lighting only/);
    }
    await fallback.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${out}/report.json`, JSON.stringify({results, errors}, null, 2));
    console.log(JSON.stringify({scenes: results.map(r => r.study), errors}));
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
