const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4185/comparison.html';
const out = path.resolve('.tools/comparison/transfer');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [], results = [];
  const watch = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error' || (m.type() === 'warning' && /GPU|invalid/i.test(m.text()))) errors.push(m.text());
    });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 2160, height: 1500 } }); watch(page);
    await page.goto(url);
    await page.waitForFunction(() => window.comparison?.ready, {}, { timeout: 60000 });
    const settle = async () => {
      await page.waitForFunction(() => comparison.state().transfer?.error ||
        (comparison.state().activeGi === 'transfer' && !comparison.state().transfer.updating), {}, { timeout: 90000 });
      assert.equal(await page.evaluate(() => comparison.state().transfer.error), '');
    };
    await settle();
    assert.equal(await page.locator('#bounces').inputValue(), '4');
    for (const hour of [9, 21]) {
      await page.locator('#time').evaluate((e, h) => { e.value = String(h); e.dispatchEvent(new Event('input', { bubbles: true })); }, hour);
      await settle();
      const pixels = await page.evaluate(async () => {
        const t = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
        return Array.from(await t.readPixels());
      });
      assert.ok(pixels.some((v, i) => i % 4 !== 3 && v > 0));
      assert.ok(pixels.every(v => Number.isFinite(v) && v >= 0));
      const referencePath = path.resolve(`.tools/comparison/colour-study/direct1024-${hour}.json`);
      let comparisonError = null;
      if (fs.existsSync(referencePath)) {
        const reference = JSON.parse(fs.readFileSync(referencePath)).pixels;
        let max = 0, sum = 0, changed = 0;
        for (let i = 0; i < pixels.length; i++) {
          if (i % 4 === 3) continue;
          const difference = Math.abs(pixels[i] - reference[i]);
          max = Math.max(max, difference); sum += difference; if (difference) changed++;
          assert.ok(difference <= Math.max(1e-6, reference[i] * .002), `Dense reference mismatch at ${i}: ${difference}`);
        }
        comparisonError = { max, mean: sum / (pixels.length / 4 * 3), changedComponents: changed };
        assert.ok(comparisonError.mean < 1e-5, 'Weighted reuse must preserve the dense result.');
      }
      const metrics = await page.evaluate(() => comparison.state().transfer);
      assert.equal(metrics.completedBounces, 4); assert.equal(metrics.lastUpdateDispatches, 8);
      results.push({ hour, metrics, comparisonError });
      await page.locator('canvas').screenshot({ path: path.join(out, `${hour}-room.png`) });
      await page.selectOption('#view', 'doorway');
      await page.locator('canvas').screenshot({ path: path.join(out, `${hour}-doorway.png`) });
      await page.selectOption('#view', 'room');
    }
    const revision = await page.evaluate(() => comparison.state().transfer.revision);
    await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
    await page.waitForTimeout(150); await page.keyboard.up('KeyW');
    assert.equal(await page.evaluate(() => comparison.state().transfer.revision), revision);
    await page.click('#reset');
    await page.selectOption('#gi', 'baked'); assert.ok(await page.locator('#bounces').isDisabled());
    await page.selectOption('#gi', 'transfer'); await settle();
    assert.equal(await page.evaluate(() => comparison.state().transfer.revision), revision);
    const hash = () => page.evaluate(async () => {
      const t = comparison.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
      const bytes = await t.readPixels();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',');
    });
    const four = await hash();
    await page.selectOption('#bounces', '1'); await settle();
    const one = await hash(); assert.notEqual(one, four);
    await page.selectOption('#bounces', '4'); await settle(); assert.equal(await hash(), four);
    await page.evaluate(async () => {
      const e = document.querySelector('#bounces');
      e.value = '1'; e.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      e.value = '4'; e.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(); assert.equal(await hash(), four);
    await page.selectOption('#gi', 'cascades');
    await page.waitForFunction(() => comparison.state().activeGi === 'cascades' && !comparison.state().cascades.updating, {}, { timeout: 90000 });
    assert.equal(await page.evaluate(() => comparison.scene.textures.filter(t => t.getInternalTexture()?._creationFlags & 1).length), 1,
      'Switching methods must release the previous GPU cache.');
    await page.selectOption('#gi', 'transfer'); await settle(); assert.equal(await hash(), four);
    await page.close();
    const fallback = await browser.newPage(); watch(fallback);
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await fallback.goto(url); await fallback.waitForFunction(() => window.comparison?.ready);
    assert.equal(await fallback.evaluate(() => comparison.state().activeGi), 'baked');
    assert.ok(await fallback.locator('#bounces').isDisabled());
    assert.equal(await fallback.locator('#gi option[value="transfer"]').evaluate(option => option.disabled), true);
    await fallback.close();
    const failed = await browser.newPage(); watch(failed);
    await failed.route('**/transfer.bin.gz', route => route.fulfill({ status: 200,
      contentType: 'application/octet-stream', body: require('node:zlib').gzipSync(Buffer.alloc(64)) }));
    await failed.goto(url);
    await failed.waitForFunction(() => window.comparison?.ready && comparison.state().transfer?.error, {}, { timeout: 60000 });
    assert.equal(await failed.evaluate(() => comparison.state().activeGi), 'baked');
    assert.match(await failed.evaluate(() => comparison.state().transfer.error), /Incomplete diffuse transfer/);
    await failed.close();
    assert.deepEqual(errors, []);
    const report = { results, errors, note: 'Desktop update scheduling includes frame spacing; not a phone benchmark. Reference equality allows floating-point summation order differences.' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
