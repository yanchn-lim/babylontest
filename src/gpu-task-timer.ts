import { PerfCounter, type Engine, type FrameGraphTask } from "@babylonjs/core";

// Use instead of whole-frame instrumentation: WebGL elapsed queries cannot overlap.
export function timeGpuTask(engine: Engine, task: FrameGraphTask, active: () => boolean) {
  const counter = new PerfCounter();
  let token: ReturnType<Engine["startTimeQuery"]> = null;
  let ended = false;
  function collect() {
    if (!token) return;
    const elapsed = engine.endTimeQuery(token);
    ended = true;
    if (elapsed < 0) return;
    counter.fetchNewFrame();
    counter.addCount(elapsed, true);
    token = null;
    ended = false;
  }
  const beforeFrame = engine.onBeginFrameObservable.add(() => {
    if (token && ended) collect();
  });
  const before = task.onBeforeTaskExecute.add(() => {
    if (active() && !token && engine.getCaps().timerQuery) token = engine.startTimeQuery();
  });
  const after = task.onAfterTaskExecute.add(() => {
    if (token && !ended) collect();
  });
  return {
    counter,
    dispose() {
      task.onBeforeTaskExecute.remove(before);
      task.onAfterTaskExecute.remove(after);
      engine.onBeginFrameObservable.remove(beforeFrame);
      // End any submitted query. Engine disposal releases pending GPU resources.
      if (token) engine.endTimeQuery(token);
    },
  };
}
