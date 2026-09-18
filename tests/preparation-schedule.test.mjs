import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparationSchedule, pausePreparation } from '../src/comparison/preparation-schedule.ts';
import { compareResult } from '../src/preparation/protocol.ts';

test('existing preparation defaults and batch memory limits stay bounded', () => {
  assert.deepEqual(preparationSchedule(), { batchSize: 256, pauseMilliseconds: 0 });
  for (const batchSize of [64, 128, 256, 512, 1024, 2048, 4096]) assert.equal(preparationSchedule({ batchSize }).batchSize, batchSize);
  for (const batchSize of [0, 63, 65, 8192, NaN, Infinity]) assert.throws(() => preparationSchedule({ batchSize }), /Batch size/);
  for (const pauseMilliseconds of [-1, 101, NaN, Infinity]) assert.throws(() => preparationSchedule({ pauseMilliseconds }), /Batch pause/);
});

test('pacing can finish, be cancelled while waiting, or reject an already cancelled run', async () => {
  await pausePreparation(0); await pausePreparation(1);
  const abort = new AbortController(), waiting = pausePreparation(100, abort.signal);
  abort.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.throws(() => pausePreparation(0, abort.signal), { name: 'AbortError' });
});

test('only completed caches for the same input are compared', () => {
  const references = new Map(), report = { outcome: 'complete', inputHash: 'scene-a', outputHash: 'cache-a' };
  assert.equal(compareResult({ ...report, outcome: 'trial' }, references), 'Not compared');
  assert.equal(compareResult({ ...report, outcome: 'cancelled' }, references), 'Not compared');
  assert.equal(compareResult({ ...report, outcome: 'failed' }, references), 'Not compared');
  assert.equal(references.size, 0);
  assert.equal(compareResult(report, references), 'Reference');
  assert.equal(compareResult({ ...report, batchSize: 1024 }, references), 'Exact match');
  assert.equal(compareResult({ ...report, inputHash: 'moved-sofa' }, references), 'Reference');
  assert.equal(compareResult({ ...report, outputHash: 'wrong' }, references), 'MISMATCH');
  assert.equal(compareResult(report, references), 'Exact match');
});
