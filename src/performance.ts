export class ShadowCache {
  private revision = 1;
  private rendered = 0;
  invalidate() { this.revision++; }
  get dirty() { return this.revision !== this.rendered; }
  begin(enabled: boolean) { return enabled && this.dirty ? this.revision : null; }
  complete(revision: number | null) {
    if (revision !== null) this.rendered = revision;
  }
}

export function createRebuildQueue(build: () => Promise<void>) {
  let pending = false;
  let active: Promise<void> | undefined;
  return function request() {
    pending = true;
    if (!active) {
      active = Promise.resolve().then(async () => {
        while (pending) {
          pending = false;
          try { await build(); }
          catch (error) { if (!pending) throw error; }
        }
      }).finally(() => { active = undefined; });
    }
    return active;
  };
}

export function summarizeFrames(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const over33Percent = sorted.filter(value => value > 33.3).length / sorted.length * 100;
  return { samples: sorted.length, medianMs, medianFps: 1000 / medianMs, p95Ms, over33Percent };
}

export class BenchmarkRun {
  readonly warmupMs = 15_000;
  readonly durationMs = 60_000;
  readonly frames: number[] = [];
  readonly gpu: number[] = [];
  private previous: number;
  readonly started: number;
  constructor(started: number) { this.started = started; this.previous = started; }
  sample(now: number, gpuMs?: number) {
    const interval = now - this.previous;
    if (this.previous >= this.started + this.warmupMs && this.previous < this.started + this.warmupMs + this.durationMs) {
      this.frames.push(interval);
      if (gpuMs !== undefined && Number.isFinite(gpuMs) && gpuMs > 0) this.gpu.push(gpuMs);
    }
    this.previous = now;
    return now >= this.started + this.warmupMs + this.durationMs;
  }
  phase(now: number) {
    const elapsed = now - this.started;
    return elapsed < this.warmupMs
      ? `Warm-up: ${Math.ceil((this.warmupMs - elapsed) / 1000)}s`
      : `Measuring: ${Math.max(0, Math.ceil((this.warmupMs + this.durationMs - elapsed) / 1000))}s`;
  }
}
