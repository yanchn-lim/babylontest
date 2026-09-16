// Focused checks for bounce transport, completed-result publication and update cost.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4185/comparison.html';
const out = path.resolve('.tools/comparison/bounces');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [], results = [], checkpoint = {};
  const open = async target => {
    const page = await browser.newPage({ viewport: { width: 2160, height: 1500 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(target);
    await page.waitForFunction(() => window.comparison?.ready, {}, { timeout: 60000 });
    await page.selectOption('#gi', 'cascades');
    await page.selectOption('#bounces', '1');
    return page;
  };
  const settle = page => page.waitForFunction(() => comparison.state().activeGi === 'cascades' && !comparison.state().cascades.updating, {}, { timeout: 90000 });
  const time = async (page, hour) => {
    await page.locator('#time').evaluate((input, h) => { input.value = String(h); input.dispatchEvent(new Event('input', { bubbles: true })); }, hour);
    await settle(page);
  };
  const sample = page => page.evaluate(async () => {
    const texture = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
    const pixels = await texture.readPixels();
    if (!(pixels instanceof Float32Array)) throw Error('Expected linear float GI pixels.');
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    let sum = 0, minDelta = Infinity, maxDelta = 0;
    for (let i = 0; i < pixels.length; i++) {
      if (i % 4 === 3) continue;
      if (!Number.isFinite(pixels[i]) || pixels[i] < 0) throw Error('Invalid GI radiance.');
      sum += pixels[i];
      if (window.previousGI) {
        const delta = pixels[i] - previousGI[i];
        minDelta = Math.min(minDelta, delta); maxDelta = Math.max(maxDelta, delta);
      }
    }
    window.previousGI = pixels;
    return { hash: Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join(''),
      mean: sum / (pixels.length / 4 * 3), minDelta, maxDelta, metrics: comparison.state().cascades };
  });
  try {
    if (process.env.COMPARISON_CHECKPOINT_URL) {
      const baseline = await open(process.env.COMPARISON_CHECKPOINT_URL);
      await settle(baseline);
      for (const hour of [12, 21]) { await time(baseline, hour); checkpoint[hour] = (await sample(baseline)).hash; }
      await baseline.close();
    }
    const page = await open(url);
    await settle(page);
    // Warm the extra-bounce shader before measuring the individual settings.
    await page.selectOption('#bounces', '4'); await settle(page);
    for (const hour of [12, 21]) {
      await time(page, hour);
      await page.evaluate(() => { window.previousGI = null; });
      let first;
      for (const bounces of [1, 2, 3, 4]) {
        await page.selectOption('#bounces', String(bounces)); await settle(page);
        const result = await sample(page);
        assert.equal(result.metrics.completedBounces, bounces);
        assert.equal(result.metrics.lastUpdateDispatches, bounces * 5);
        if (bounces === 1) {
          first = result.hash;
          if (checkpoint[hour]) assert.equal(first, checkpoint[hour], 'One bounce must preserve the approved GI.');
        } else {
          assert.ok(result.minDelta >= -1e-6, 'An extra bounce must not subtract radiance.');
          assert.ok(result.maxDelta > 0, 'An extra bounce must transport additional light.');
        }
        results.push({ hour, bounces, ...result });
        await page.locator('canvas').screenshot({ path: path.join(out, `${hour}-${bounces}-room.png`) });
        if (bounces === 1 || bounces === 4) {
          await page.selectOption('#view', 'doorway');
          await page.locator('canvas').screenshot({ path: path.join(out, `${hour}-${bounces}-doorway.png`) });
          await page.selectOption('#view', 'room');
        }
      }
      const revision = await page.evaluate(() => comparison.state().cascades.revision);
      await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
      await page.waitForTimeout(100); await page.keyboard.up('KeyW');
      assert.equal(await page.evaluate(() => comparison.state().cascades.revision), revision);
      await page.click('#reset');
      await page.selectOption('#bounces', '1'); await settle(page);
      assert.equal((await sample(page)).hash, first, 'Returning to one bounce must clear higher-bounce history.');
    }
    // A new choice during a four-bounce update must queue, not overwrite its inputs.
    const stable = await page.evaluate(async () => {
      const input = document.querySelector('#bounces');
      input.value = '4'; input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const texture = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
      const intermediate = await texture.readPixels();
      const unchanged = intermediate.every((value, i) => value === previousGI[i]);
      input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true }));
      return unchanged;
    });
    assert.ok(stable, 'Do not publish an unfinished bounce series.');
    await settle(page);
    assert.equal(await page.evaluate(() => comparison.state().cascades.completedBounces), 2);
    assert.equal((await sample(page)).hash, results.find(r => r.hour === 21 && r.bounces === 2).hash,
      'A queued change must produce the same result as a fresh update.');
    await page.selectOption('#gi', 'baked');
    assert.ok(await page.locator('#bounces').isDisabled());
    await page.selectOption('#gi', 'cascades');
    assert.ok(await page.locator('#bounces').isEnabled());
    assert.deepEqual(errors, []);
    const report = { results, checkpoint, errors, note: 'One warmed desktop run. Wall timing spans update scheduling, not isolated GPU time or phone performance.' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
