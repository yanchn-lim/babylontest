// Focused smoke check for the comparison scene.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4185/comparison.html';
const out = path.resolve('.tools/comparison');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [];
  const checks = [];
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text() + ' ' + message.location().url); });
    page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    watch(page);
    await page.goto(url);
    await page.waitForFunction(() => window.comparison?.ready, {}, { timeout: 60000 });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = () => page.evaluate(() => comparison.state());
    const settleGI = async () => {
      await page.waitForFunction(() => {
        const state = comparison.state();
        return state.cascades?.error || (state.activeGi === 'cascades' && !state.cascades.updating);
      }, {}, { timeout: 90000 });
      assert.equal((await state()).cascades.error, '');
      assert.equal((await state()).activeGi, 'cascades');
      await settle();
    };
    await settleGI();
    const cascadeMetrics = [(await state()).cascades];
    const setTime = async hour => {
      await page.locator('#time').evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, hour);
      await settleGI();
    };
    const capture = async name => {
      await page.locator('#reference').evaluate(image => image.decode());
      await settle();
      await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
    };
    assert.equal((await state()).on, false);
    assert.match((await state()).reference, /room-12-off.png$/);
    await capture('daylight');
    await setTime(21);
    assert.equal((await state()).on, true);
    await capture('night');
    cascadeMetrics.push((await state()).cascades);
    checks.push('Auto lighting switches between noon and night; exact references load.');
    await page.selectOption('#lights', 'off');
    await settleGI();
    assert.equal((await state()).on, false);
    assert.match((await state()).reference, /room-21-off.png$/);
    await page.selectOption('#lights', 'on');
    await setTime(12);
    assert.equal((await state()).on, true);
    checks.push('Manual On and Off override Auto and persist through time changes.');
    await page.selectOption('#lights', 'auto');
    await setTime(10.4);
    assert.equal((await state()).reference, null);
    assert.match(await page.locator('#reference-note').innerText(), /No exact reference/);
    const revisionBeforeDrag = (await state()).cascades.revision;
    const revisionDuringDrag = await page.evaluate(async () => {
      const input = document.querySelector('#time');
      for (let step = 0; step < 12; step++) {
        input.value = String(9 + step * .1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(requestAnimationFrame);
      }
      return comparison.state().cascades.revision;
    });
    assert.ok(revisionDuringDrag > revisionBeforeDrag, 'Continuous time input must not starve GI updates.');
    await settleGI();
    assert.equal((await state()).hour, 10.1);
    checks.push('Intermediate times render and do not display a mismatched reference.');
    await setTime(12);
    const revision = (await state()).cascades.revision;
    const before = await page.evaluate(() => comparison.camera.position.asArray());
    await page.locator('canvas').focus();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(180);
    await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => comparison.camera.position.asArray());
    assert.ok(Math.hypot(...after.map((v, i) => v - before[i])) > .03);
    assert.equal((await state()).cameraMatches, false);
    assert.equal((await state()).cascades.revision, revision, 'Walking must not recalculate GI.');
    await page.click('#reset');
    assert.equal((await state()).cameraMatches, true);
    checks.push('Walking moves the camera, hides the reference, and Reset restores alignment.');
    await page.selectOption('#view', 'doorway');
    assert.match((await state()).reference, /doorway-12-off.png$/);
    await capture('doorway');
    await page.selectOption('#gi', 'baked');
    await settle();
    assert.equal((await state()).activeGi, 'baked');
    await capture('doorway-baked');
    await page.selectOption('#gi', 'cascades');
    await settleGI();
    assert.equal((await state()).cascades.revision, revision, 'Switching GI must reuse the existing result.');
    checks.push('Radiance cascades complete; baked switching works; camera motion reuses GI.');
    await page.selectOption('#layout', 'overlay');
    await page.locator('#blend').fill('0.5');
    await capture('overlay');
    checks.push('Both saved views, overlay layout and opacity control work.');
    // Exercise the other shader language and narrow layout without a performance benchmark.
    const fallback = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    watch(fallback);
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await fallback.goto(url);
    await fallback.waitForFunction(() => window.comparison?.ready, {}, { timeout: 60000 });
    assert.match(await fallback.locator('#status').innerText(), /WebGL/);
    assert.equal(await fallback.locator('#gi').inputValue(), 'baked');
    assert.ok(await fallback.locator('#gi option[value="cascades"]').evaluate(option => option.disabled));
    assert.ok(await fallback.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await fallback.screenshot({ path: path.join(out, 'narrow-webgl.png'), fullPage: true });
    checks.push('WebGL fallback renders; the narrow touch layout has no horizontal overflow.');
    assert.deepEqual(errors, []);
    const report = { checks, errors, cascadeMetrics, note: 'Desktop smoke checks only; no iPhone performance or visual-parity claim.' };
    fs.writeFileSync(path.join(out, 'smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
