const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UI_OUTPUT || path.join(require('node:os').tmpdir(), 'babylontest-baked-switch');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const report = { errors: [], gpuErrors: [], switches: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1914, height: 941 } });
    page.setDefaultTimeout(180000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.addInitScript(() => {
      window.gpuErrors = [];
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await requestDevice.apply(this, args);
        device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
        return device;
      };
      localStorage.setItem('babylon-graphics-v1', JSON.stringify({
        'gi-mode': 'realtime', 'sun-intensity': '6', exposure: '1',
        'day-cycle': true, 'day-time': '8.189', 'day-length': '10',
        shadows: '2048', 'shadow-filter': 'medium', 'shadow-bias': '0.005',
        'shadow-normal-bias': '0.028', 'shaft-strength': '0.4', 'shaft-scattering': '0.3',
      }));
      localStorage.setItem('babylon-materials-v1-bukit-merah', JSON.stringify({
        '4:Paint | warm white': { normal: 3 },
      }));
    });
    await page.goto(process.env.UI_URL || 'http://127.0.0.1:4173/?scene=bukit-merah');
    await page.waitForFunction(() => window.lighting && !document.querySelector('#controls').disabled);
    await page.evaluate(() => {
      lighting.camera.position.set(-10.968832403743207, 1.65, -5.479344875195395);
      lighting.camera.rotation.set(0.702, -1.9434073464102029, 0);
    });
    await page.waitForFunction(() => lighting.gi?.phase === 'settled');
    await page.evaluate(() => {
      document.querySelector('#add-point').click();
      document.querySelector('#add-point').click();
    });
    await page.waitForFunction(() => lighting.controller.fixtures.length === 2 && lighting.gi.phase === 'settled');
    await page.waitForTimeout(1000);
    const epoch = await page.evaluate(() => lighting.gi.epoch);
    for (const mode of ['baked', 'realtime', 'baked', 'realtime']) {
      await page.evaluate(mode => {
        const control = document.querySelector('#gi-mode');
        control.value = mode;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }, mode);
      await page.waitForTimeout(1500);
      const pixels = await page.evaluate(() => new Promise((resolve, reject) => {
        const engine = lighting.scene.getEngine();
        lighting.scene.onAfterRenderObservable.addOnce(() => {
          engine.readPixels(Math.floor(engine.getRenderWidth() / 2),
            Math.floor(engine.getRenderHeight() / 2), 4, 4, true, true)
            .then(data => resolve(Array.from(data))).catch(reject);
        });
      }));
      assert.ok(pixels.some(value => value !== 0), 'The canvas must contain a rendered image');
      const state = await page.evaluate(() => ({
        enabled: lighting.gi.enabled, epoch: lighting.gi.epoch,
        fixtures: lighting.controller.fixtures.filter(fixture => fixture.enabled).length,
        lightmaps: lighting.scene.materials.filter(material => material.lightmapTexture).length,
        gpuErrors: [...gpuErrors],
      }));
      assert.equal(state.enabled, mode === 'realtime');
      assert.equal(state.epoch, epoch, 'Mode switching must retain cached GI');
      assert.equal(state.fixtures, 2, 'Both lamps must remain enabled');
      assert.equal(state.lightmaps, mode === 'baked' ? 12 : 0);
      assert.deepEqual(state.gpuErrors, [], 'Mode switching must not exceed GPU binding limits');
      report.switches.push({ mode, ...state });
      await page.screenshot({ path: path.join(output, mode + '.png') });
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => lighting.scene.dispose());
    await page.waitForTimeout(500);
    report.gpuErrors = await page.evaluate(() => gpuErrors);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.gpuErrors, []);
    report.passed = true;
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
