import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/interior-lighting/') && specifier.startsWith('./') && !specifier.includes('.')) return next(specifier + '.ts', context);
    if (context.parentURL?.includes('/interior-lighting/') && specifier.startsWith('./') && !/\.(ts|wgsl\?raw)$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.wgsl?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(new URL(url.split('?')[0]), 'utf8')), shortCircuit: true };
    if (url.includes('/interior-lighting/') && url.endsWith('.ts')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true };
    return next(url, context);
  },
});
const { ProbeGI } = await import('../src/interior-lighting/probe-gi.ts');
function scheduler() {
  const visits = new Uint32Array(462), clears = [];
  const g = Object.assign(Object.create(ProbeGI.prototype), { plugins: [] });
  Object.assign(g, { count: visits.length, enabled: true, error: '', disposed: false, prepPass: 6, prepCursor: 0, cursor: 0, processed: 0, epoch: 1, updates: 64,
    params: { updateFloat4() {}, update() {} }, history: { update() {} }, irradiance: { update(values) { clears.push(values); } },
    shader: { dispatch(count) { for (let i = g.cursor; i < g.cursor + count; i++) visits[i % g.count]++; return true; } },
  });
  return { g, visits, clears };
}
test('continuous lighting edits update every apartment probe instead of restarting at probe zero', () => {
  const { g, visits, clears } = scheduler();
  for (let frame = 0; frame < 24; frame++) { g.reset(false); g.tick(); }
  assert.ok(visits.every(count => count >= 3));
  assert.equal(clears.length, 0, 'Keep the last completed sample while the replacement is scheduled');
  visits.fill(0); g.reset(false);
  for (let frame = 0; frame < 200 && g.progress < 1; frame++) g.tick();
  assert.equal(g.progress, 1);
  assert.ok(visits.every(count => count === 16), 'Every probe receives sixteen batches after the final edit');
});
test('explicit reset clears visible radiance and dispatch failure does not advance progress', () => {
  const { g, clears } = scheduler(); g.reset();
  assert.equal(clears.length, 1); assert.ok(clears[0].every(v => v === 0));
  g.shader.dispatch = () => false; g.tick(); assert.equal(g.progress, 0);
});

test('wrapped updates use the frame budget without repeating a probe within a dispatch', () => {
  for (const updates of [32, 64]) {
    const { g, visits } = scheduler(), batches = [];
    g.updates = updates;
    const dispatch = g.shader.dispatch;
    g.shader.dispatch = count => { batches.push(count); return dispatch(count); };
    while (g.progress < 1) g.tick();
    assert.equal(batches.length, Math.ceil(g.count * 16 / updates));
    assert.ok(batches.every(count => count > 0 && count <= updates && count <= g.count));
    assert.ok(visits.every(count => count === 16));
    if (updates === 64) assert.equal(batches.length, 116);
  }
});
