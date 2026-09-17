const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const study = process.env.COUCH_STUDY || 'couch';
if (!['couch', 'applaryd'].includes(study)) throw Error('Unknown couch study.');
const out = `.tools/${study}-study`;
const url = process.env.COMPARISON_URL || 'http://127.0.0.1:4193/comparison.html';

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route(url, route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Couch asset preparation</title>',
    }));
    await page.goto(url);
    const geometry = await page.evaluate(async study => {
      const B = await import('/node_modules/.vite/deps/@babylonjs_core.js');
      const { loadCouch } = await import('/src/comparison/couch-study.ts');
      const engine = new B.Engine(document.createElement('canvas')), scene = new B.Scene(engine);
      scene.useRightHandedSystem = true;
      const sofa = await loadCouch(scene, study);
      const result = sofa.meshes.map(mesh => ({ positions: Array.from(mesh.getVerticesData('position')) }));
      scene.dispose(); engine.dispose(); return result;
    }, study);
    fs.writeFileSync(`${out}/geometry.json`, JSON.stringify(geometry));
    execFileSync(process.env.BLENDER || '.tools/blender-4.5.3-windows-x64/blender.exe', ['-b', '-t', '4', '--python', 'scripts/unwrap-couch.py', '--', study], { stdio: 'inherit' });
    await page.goto(url);
    const data = await page.evaluate(async study => {
      const B = await import('/node_modules/.vite/deps/@babylonjs_core.js');
      const { loadCouch } = await import('/src/comparison/couch-study.ts');
      const { offsetStudy } = await import('/src/comparison/offset-study.ts');
      const { prepareScene } = await import('/src/apartment/prepare-scene.ts');
      const room = offsetStudy(await (await fetch('/comparison/scene.json')).json(), false);
      room.meshes = room.meshes.slice(0, 2); room.materials.pop();
      room.views.room = { position: [2.2, 1.4, 2.1], target: [0, .45, -1], fov: .8 };
      room.views.doorway = { position: [.95, .95, .65], target: [0, .4, -1], fov: .85 };
      if (study === 'applaryd') {
        room.views.room = { position: [2.45, 1.8, 2.6], target: [0, .45, -1], fov: .95 };
        room.views.doorway = { position: [.5, 1.65, .85], target: [0, .45, -1], fov: 1.15 };
      }
      const engine = new B.Engine(document.createElement('canvas')), scene = new B.Scene(engine);
      scene.useRightHandedSystem = true;
      const sofa = await loadCouch(scene, study);
      const atlas = await (await fetch(`/comparison/${study}/atlas.json`)).json();
      sofa.meshes.forEach((mesh, i) => mesh.setVerticesData('uv3', atlas[i]));
      const data = await prepareScene(sofa.meshes, sofa.materials, room);
      data.meshes.forEach(mesh => { mesh.material += room.materials.length; });
      room.meshes.push(...data.meshes); room.materials.push(...data.materials);
      scene.dispose(); engine.dispose(); return room;
    }, study);
    fs.writeFileSync(`public/comparison/${study}/scene.json`, JSON.stringify(data));
    console.log('Prepared couch scene:', data.meshes.length, 'meshes. Generate both transfer caches next.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
