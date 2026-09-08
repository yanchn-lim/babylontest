import assert from "node:assert/strict";
import { test } from "node:test";
import { Observable } from "@babylonjs/core";
import { timeGpuTask } from "../src/gpu-task-timer.ts";

test("task timing waits for query results without overlapping queries and drains after stop", () => {
  let active = true, ready = false, starts = 0;
  const engine = {
    onBeginFrameObservable: new Observable(),
    getCaps: () => ({ timerQuery: true }),
    startTimeQuery: () => ({ id: ++starts }),
    endTimeQuery: () => ready ? 250000 : -1,
  };
  const task = { onBeforeTaskExecute: new Observable(), onAfterTaskExecute: new Observable() };
  const timer = timeGpuTask(engine, task, () => active);
  const frame = () => {
    engine.onBeginFrameObservable.notifyObservers(engine);
    task.onBeforeTaskExecute.notifyObservers(task);
    task.onAfterTaskExecute.notifyObservers(task);
  };
  frame(); frame();
  assert.equal(starts, 1);
  assert.equal(timer.counter.count, 0);
  active = false;
  ready = true;
  frame();
  assert.equal(starts, 1);
  assert.equal(timer.counter.count, 1);
  assert.equal(timer.counter.current, 250000);
  timer.dispose();
  assert.equal(task.onBeforeTaskExecute.hasObservers(), false);
  assert.equal(task.onAfterTaskExecute.hasObservers(), false);
  assert.equal(engine.onBeginFrameObservable.hasObservers(), false);
});

test("unsupported GPU timing does not submit queries", () => {
  const engine = {
    onBeginFrameObservable: new Observable(),
    getCaps: () => ({ timerQuery: null }),
    startTimeQuery: () => assert.fail("unsupported query"),
  };
  const task = { onBeforeTaskExecute: new Observable(), onAfterTaskExecute: new Observable() };
  const timer = timeGpuTask(engine, task, () => true);
  task.onBeforeTaskExecute.notifyObservers(task);
  task.onAfterTaskExecute.notifyObservers(task);
  assert.equal(timer.counter.count, 0);
  timer.dispose();
});
