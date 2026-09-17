const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.REFLECTION_URL || 'http://127.0.0.1:4185/';
const out = path.resolve('.tools/reflections');
fs.mkdirSync(out, { recursive: true });

function area(positions, indices) {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map(j => positions.slice(j * 3, j * 3 + 3));
    const u = b.map((v, k) => v - a[k]), v = c.map((v, k) => v - a[k]);
    total += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return total;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [], results = [];
  try {
    for (const backend of ['webgpu', 'webgl']) for (const name of ['comparison', 'apartment']) {
      const page = await browser.newPage({ viewport: name === 'comparison' ? { width: 2160, height: 1500 } : { width: 1440, height: 1150 } });
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
      if (backend === 'webgl') await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
      await page.goto(new URL(name + '.html', base).href);
      await page.waitForFunction(name => window[name]?.ready, name, { timeout: 60000 });
      await page.evaluate(name => { window.testScene = window[name]; }, name);
      const settle = async () => {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForFunction(() => testScene.state().reflections.error ||
          (testScene.state().reflections.ready && !testScene.state().reflections.updating && !testScene.state().transfer?.updating), {}, { timeout: 90000 });
        const state = await page.evaluate(() => testScene.state());
        assert.equal(state.reflections.error, '');
        return state;
      };
      const setTime = async hour => {
        await page.locator('#time').evaluate((e, h) => { e.value = String(h); e.dispatchEvent(new Event('input')); }, hour);
        return settle();
      };
      const giHash = () => page.evaluate(async () => {
        const texture = testScene.scene.textures.find(t => t.getInternalTexture()?._creationFlags & 1);
        if (!texture) return null;
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await texture.readPixels()))).join(',');
      });
      await settle();
      const day = await setTime(9), gi = await giHash();
      const captureInfo = await page.evaluate(() => testScene.scene.reflectionProbes.map(probe => {
        const t = probe.cubeTexture, sh = t.sphericalPolynomial;
        return { automatic: t.isRenderTarget, width: t.getSize().width, gamma: t.gammaSpace,
          diffuse: ['x', 'y', 'z', 'xx', 'yy', 'zz', 'xy', 'yz', 'zx'].flatMap(k => sh[k].asArray()) };
      }));
      assert.equal(captureInfo.length, name === 'comparison' ? 1 : 9);
      assert.ok(captureInfo.every(c => !c.automatic && c.width === 128 && !c.gamma && c.diffuse.every(v => v === 0)));
      await page.locator('canvas').screenshot({ path: path.join(out, `${name}-${backend}-day-on.png`) });
      if (name === 'apartment') {
      await page.selectOption('#reflections', 'off');
      assert.equal(await page.evaluate(() => testScene.scene.materials.filter(m => m.reflectionTexture).length), 0);
      assert.equal(await giHash(), gi, 'Reflection switching must not change diffuse GI.');
      await page.locator('canvas').screenshot({ path: path.join(out, `${name}-${backend}-day-off.png`) });
      await page.selectOption('#reflections', 'on'); await settle();
      assert.equal((await page.evaluate(() => testScene.state())).reflections.captures, day.reflections.captures);
      }
      await page.locator('canvas').focus(); await page.keyboard.down('KeyW');
      await page.waitForTimeout(180); await page.keyboard.up('KeyW');
      assert.equal((await page.evaluate(() => testScene.state())).reflections.captures, day.reflections.captures);
      assert.equal(await giHash(), gi); await page.click('#reset');
      const night = await setTime(21);
      assert.ok(night.reflections.revision > day.reflections.revision);
      assert.equal(await page.evaluate(() => testScene.scene.reflectionProbes.length), captureInfo.length);
      await page.locator('canvas').screenshot({ path: path.join(out, `${name}-${backend}-night-on.png`) });
      if (backend === 'webgpu') {
        await page.selectOption('#lights', 'off'); await settle();
        // Change lighting during a capture; only the latest complete set may win.
        await page.locator('#time').evaluate(e => { e.value = '12'; e.dispatchEvent(new Event('input')); });
        await page.waitForFunction(() => testScene.state().reflections.updating);
        await page.locator('#time').evaluate(e => { e.value = '15'; e.dispatchEvent(new Event('input')); });
        await settle();
        assert.equal(await page.evaluate(() => testScene.scene.reflectionProbes.length), captureInfo.length);
      }
      if (name === 'apartment' && backend === 'webgpu') {
        const meshes = await page.evaluate(() => testScene.scene.meshes.filter(m => m.getTotalVertices()).map(m => ({
          name: m.material.name.split(' · ')[0], positions: Array.from(m.getVerticesData('position')), indices: Array.from(m.getIndices()),
        })));
        const data = JSON.parse(fs.readFileSync('public/apartment-transfer/scene.json'));
        for (const mesh of data.meshes) {
          const expected = area(mesh.positions, mesh.indices), name = data.materials[mesh.material].name;
          const actual = meshes.filter(m => m.name === name).reduce((sum, m) => sum + area(m.positions, m.indices), 0);
          assert.ok(Math.abs(actual - expected) < Math.max(1e-5, expected * 1e-6), `Room partition changed geometry: ${name}`);
        }
      }
      results.push({ name, backend, day: day.reflections, night: night.reflections });
      await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
