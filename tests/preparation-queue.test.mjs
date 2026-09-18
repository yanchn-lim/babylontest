import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreparationQueue } from '../src/preparation/queue.ts';
import { interactiveSchedule } from '../src/comparison/preparation-schedule.ts';
const wait = () => new Promise(resolve => setTimeout(resolve, 15));

test('obsolete work cannot publish and only the newest pending snapshot starts', async () => {
  const jobs = [], ready = [], errors = [];
  const queue = createPreparationQueue({ prepare(input, signal) {
    return new Promise((resolve, reject) => jobs.push({ input, signal, resolve, reject }));
  }, ready: value => ready.push(value), error: error => errors.push(error) });
  try {
    queue.request(1); await wait();
    queue.request(2); queue.request(3); await wait();
    assert.equal(jobs.length, 1); assert.equal(jobs[0].signal.aborted, true);
    jobs[0].resolve('stale'); await wait();
    assert.equal(jobs.length, 2); assert.equal(jobs[1].input, 3); assert.deepEqual(ready, []);
    jobs[1].resolve('current'); await wait(); assert.deepEqual(ready, ['current']); assert.deepEqual(errors, []);
  } finally { queue.dispose(); }
});

test('cancelled delayed requests and disposed running results never publish', async () => {
  let called = 0, finish; const ready = [];
  const queue = createPreparationQueue({ prepare() { called++; return new Promise(resolve => { finish = resolve; }); },
    ready: value => ready.push(value), error: error => { throw error; } });
  queue.request(1, 100); queue.cancel(); await wait(); assert.equal(called, 0);
  queue.request(2); await wait(); queue.dispose(); finish('late'); await wait();
  assert.deepEqual(ready, []); queue.request(3); await wait(); assert.equal(called, 1);
});

test('current failures are reported and do not block a retry', async () => {
  const ready = [], errors = [];
  const queue = createPreparationQueue({ prepare: async input => { if (!input) throw Error('failed'); return input; },
    ready: value => ready.push(value), error: error => errors.push(error.message) });
  try { queue.request(0); await wait(); queue.request(1); await wait();
    assert.deepEqual(errors, ['failed']); assert.deepEqual(ready, [1]);
  } finally { queue.dispose(); }
});

test('interactive scheduling reduces load on slow frames within configured limits', () => {
  assert.deepEqual(interactiveSchedule(16, 1024, 8), { batchSize: 512, pauseMilliseconds: 8 });
  assert.deepEqual(interactiveSchedule(40, 1024, 8), { batchSize: 128, pauseMilliseconds: 32 });
  assert.deepEqual(interactiveSchedule(40, 64, 64), { batchSize: 64, pauseMilliseconds: 64 });
});

test('active state distinguishes queued, cancelled, finished and idle work', async () => {
  let finish;
  const queue = createPreparationQueue({ prepare: () => new Promise(resolve => { finish = resolve; }),
    ready: () => {}, error: error => { throw error; } });
  try {
    assert.equal(queue.active, false);
    queue.request(1, 100); assert.equal(queue.active, true);
    queue.cancel(); assert.equal(queue.active, false);
    queue.request(2); await wait(); assert.equal(queue.active, true);
    queue.cancel(); assert.equal(queue.active, false);
    finish(); await wait(); assert.equal(queue.active, false);
    queue.request(3); await wait(); finish(); await wait(); assert.equal(queue.active, false);
  } finally { queue.dispose(); }
});
