/** One running snapshot and one replaceable pending snapshot. */
export function createPreparationQueue<T, R>(options: {
  prepare: (input: T, signal: AbortSignal) => Promise<R>;
  ready: (result: R, input: T) => void;
  error: (error: unknown) => void;
}) {
  let version = 0, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { input: T; version: number; due: number } | undefined, disposed = false;
  function schedule() {
    clearTimeout(timer);
    if (!disposed && !controller && pending) timer = setTimeout(start, Math.max(0, pending.due - Date.now()));
  }
  async function start() {
    if (disposed || controller || !pending) return;
    const job = pending, abort = new AbortController(); pending = undefined; controller = abort;
    try {
      const result = await options.prepare(job.input, abort.signal);
      if (!disposed && job.version === version && !abort.signal.aborted) options.ready(result, job.input);
    } catch (error) {
      if (!disposed && job.version === version && !abort.signal.aborted) options.error(error);
    } finally { controller = undefined; schedule(); }
  }
  return {
    get active() { return !!pending || !!controller && !controller.signal.aborted; },
    request(input: T, delay = 0) {
      if (disposed) return;
      pending = { input, version: ++version, due: Date.now() + delay }; controller?.abort(); schedule();
    },
    cancel() { version++; pending = undefined; clearTimeout(timer); controller?.abort(); },
    dispose() { this.cancel(); disposed = true; },
  };
}
