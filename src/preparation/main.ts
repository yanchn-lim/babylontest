import { createPreview } from './preview';
import { compareResult, type RunReport, type RunSettings, type WorkerReply, type WorkerRequest } from './protocol';
import { createPreparationQueue } from './queue';
import type { Placement } from './fixture';
import { layoutLabels, type Layout } from './furnishings';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'), progress = element<HTMLProgressElement>('progress');
const placement = element<HTMLSelectElement>('placement'), batch = element<HTMLSelectElement>('batch'), pause = element<HTMLSelectElement>('pause');
const layout = element<HTMLSelectElement>('layout'), strategy = element<HTMLSelectElement>('strategy');
const base = new URL(import.meta.env.BASE_URL, location.href).href;
let preview: Awaited<ReturnType<typeof createPreview>>, worker: Worker | undefined, busy = false, id = 0;
let trialRun = false, revision = 0;
const interactive = element<HTMLInputElement>('interactive'), automatic = element<HTMLInputElement>('automatic');
const streaming = element<HTMLInputElement>('streaming');
const progressive = element<HTMLInputElement>('progressive');
let firstStream = 0;
let checkpoints: { rays: number; milliseconds: number }[] = [];
let budgetFrame = 0, budgetAt = 0;
let completed: { revision: number; started: number; installationStarted: number; report: Report } | undefined;
let installationGap = 0, installationFrame = 0, installationRequest = 0;
let frameGap = 0, previousFrame = 0, frameRequest = 0, runStarted = 0;
const references = new Map<string, string>();
type Report = RunReport & { frameGapMilliseconds: number; comparison: string; firstStreamMilliseconds?: number; streamUpdates: number;
  checkpoints: { rays: number; milliseconds: number }[]; completeGIMilliseconds?: number; installationMilliseconds?: number; installationFrameGapMilliseconds?: number };
const reports: Report[] = [];
const seconds = (value: number) => (value / 1000).toFixed(2) + ' s';
function setBusy(value: boolean) {
  busy = value;
  for (const name of ['batch', 'pause', 'strategy', 'interactive', 'streaming', 'reset-worker']) (element(name) as HTMLButtonElement).disabled = value;
  for (const name of ['trial', 'full', 'layout', 'placement', 'automatic']) (element(name) as HTMLButtonElement).disabled = false;
  element<HTMLButtonElement>('stop').disabled = !value;
  progressive.disabled = value || !streaming.checked || strategy.value !== 'active';
  preview.pause(document.hidden);
}
function heartbeat(now: number) {
  if (!busy) return;
  if (previousFrame) { frameGap = Math.max(frameGap, now - previousFrame); budgetFrame = Math.max(budgetFrame, now - previousFrame); }
  if (now - budgetAt > 250) {
    worker?.postMessage({ type: 'budget', id, frameMilliseconds: budgetFrame } satisfies WorkerRequest);
    budgetAt = now; budgetFrame = 0;
  }
  previousFrame = now; frameRequest = requestAnimationFrame(heartbeat);
}
function installationHeartbeat(now: number) {
  if (!completed || preview.diagnostics().phase !== 'installing') return;
  if (installationFrame) installationGap = Math.max(installationGap, now - installationFrame);
  installationFrame = now; installationRequest = requestAnimationFrame(installationHeartbeat);
}
function metrics(report: Report) {
  const t = report.timings;
  const values: [string, string][] = [['Total', seconds(report.totalMilliseconds)], ...Object.entries(report.stages).map(([name, ms]): [string, string] => [name, seconds(ms)])];
  if (report.counts) values.push(['Furniture pieces', String(report.counts.objects)], ['Source triangles', report.counts.triangles.toLocaleString()]);
  if (report.ignoredTriangles !== undefined) values.push(['Zero-area faces excluded', String(report.ignoredTriangles)]);
  if (report.atlasHeight) values.push(['Lighting atlas', `256 × ${report.atlasHeight}`]);
  if (report.atlasBuilds !== undefined) values.push(['Atlas builds / reused', `${report.atlasBuilds} / ${report.atlasCacheHits}`], ['Packing attempts', String(report.packingAttempts)]);
  if (report.error) values.push(['Failure', report.error]);
  if (report.outputHash) values.push(['Cache SHA-256', report.outputHash]);
  if (t) values.push(['GPU + readback wait', seconds(t.readbackMilliseconds)], ['CPU hit packing', seconds(t.packingMilliseconds)],
    ['Dispatch / compilation', seconds(t.dispatchMilliseconds)], ['Intentional pauses', seconds(t.pauseMilliseconds)],
    ['Largest batch', seconds(t.maxBatchMilliseconds)], ['Work items processed', t.processedSamples.toLocaleString()], ['Total atlas slots', t.atlasPixels.toLocaleString()],
    ['Active samples processed', t.activeSamples.toLocaleString()], ['Ray readback', (t.readbackBytes / 1048576).toFixed(1) + ' MiB']);
  if (t?.pipelinedBatches !== undefined) values.push(['Overlapped batches', String(t.pipelinedBatches)], ['Provisional samples calculated', String(t.previewSamples)]);
  values.push(['Largest page frame gap', report.frameGapMilliseconds.toFixed(0) + ' ms']);
  if (report.firstStreamMilliseconds !== undefined) values.push(['First streamed lighting', seconds(report.firstStreamMilliseconds)], ['Stream updates', String(report.streamUpdates)]);
  for (const pass of t?.refinementPasses ?? []) values.push([`${pass.rays}-ray coverage (since transfer start)`, seconds(pass.milliseconds)]);
  for (const checkpoint of report.checkpoints) values.push([`${checkpoint.rays}-ray four-bounce GI visible`, seconds(checkpoint.milliseconds)]);
  if (report.completeGIMilliseconds !== undefined) values.push(['Time to complete GI', seconds(report.completeGIMilliseconds)],
    ['Lighting installation', seconds(report.installationMilliseconds!)], ['Largest installation frame gap', report.installationFrameGapMilliseconds!.toFixed(0) + ' ms']);
  element('metrics').replaceChildren(...values.flatMap(([name, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd];
  }));
}
function finish() { cancelAnimationFrame(frameRequest); frameGap = Math.max(frameGap, previousFrame ? performance.now() - previousFrame : 0); setBusy(false); }
type Result = Extract<WorkerReply, { type: 'result' }>;
type Snapshot = { revision: number; settings: RunSettings };
function prepare(snapshot: Snapshot, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const current = worker, jobId = ++id;
    let settled = false, timeout: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: unknown, result?: Result) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel);
      current.onmessage = null; current.onerror = null; finish();
      if (error || result?.report.outcome !== 'complete') preview.cancelStream(snapshot.revision);
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => {
      preview.cancelStream(snapshot.revision);
      current.postMessage({ type: 'cancel', id: jobId } satisfies WorkerRequest);
      timeout = setTimeout(() => {
        current.terminate(); if (worker === current) worker = undefined;
        done(signal.reason);
      }, 1500);
    };
    signal.addEventListener('abort', cancel, { once: true });
    current.onerror = event => { current.terminate(); if (worker === current) worker = undefined; done(Error(event.message || 'Preparation worker failed.')); };
    current.onmessage = async ({ data }: MessageEvent<WorkerReply>) => {
      if (data.id !== jobId || settled) return;
      if (data.type === 'checkpoint') {
        try {
          if (!signal.aborted && snapshot.revision === revision && await preview.applyCheckpoint({ revision: snapshot.revision, ...data })) {
            checkpoints.push({ rays: data.rays, milliseconds: performance.now() - runStarted });
          }
        } catch (error) {
          if (!settled && !signal.aborted) { current.terminate(); if (worker === current) worker = undefined; done(error); }
        } finally {
          if (!settled && !signal.aborted) current.postMessage({ type: 'checkpoint-ack', id: jobId, rays: data.rays } satisfies WorkerRequest);
        }
        return;
      }
      if (data.type === 'stream-start' || data.type === 'stream-chunk') {
        try {
          if (!signal.aborted && snapshot.revision === revision) {
            if (data.type === 'stream-start') preview.beginStream({ revision, atlas: data.atlas, sceneData: data.sceneData, lighting: data.lighting, checkpoints: data.checkpoints });
            else if (preview.updateStream({ revision, ...data }) && !firstStream) firstStream = performance.now() - runStarted;
          }
        } catch (error) {
          current.terminate(); if (worker === current) worker = undefined; done(error);
        } finally {
          if (data.type === 'stream-chunk' && !settled) current.postMessage({ type: 'stream-ack', id: jobId, sequence: data.sequence } satisfies WorkerRequest);
        }
        return;
      }
      if (data.type === 'progress') {
        if (signal.aborted) return;
        progress.value = Math.min(1, trialRun && data.stage === 'Transfer' && data.timings ? data.timings.processedSamples / 4096 : data.fraction);
        status.textContent = `${data.stage}${data.stage === 'Transfer' && data.timings?.refinementRays ? ` · ${data.timings.refinementRays} rays/sample` : ''} · ${Math.round(progress.value * 100)}% · ${seconds(performance.now() - runStarted)}`;
      } else if (data.type === 'error') done(Error(data.message));
      else done(undefined, data);
    };
    trialRun = snapshot.settings.trial; setBusy(true);
    frameGap = 0; firstStream = 0; checkpoints = []; previousFrame = 0; budgetFrame = 0; budgetAt = 0; runStarted = performance.now(); progress.value = 0;
    status.textContent = 'Preparing lighting · navigation and placement remain available';
    frameRequest = requestAnimationFrame(heartbeat);
    current.postMessage({ type: 'run', id: jobId, base, settings: snapshot.settings } satisfies WorkerRequest);
  });
}
function receive(data: Result, snapshot: Snapshot) {
  if (snapshot.revision !== revision) return;
  const comparison = compareResult(data.report, references);
  const report: Report = { ...data.report, frameGapMilliseconds: frameGap, comparison, firstStreamMilliseconds: firstStream || undefined,
    streamUpdates: firstStream ? preview.diagnostics().streamUpdates : 0, checkpoints: [...checkpoints] };
  reports.unshift(report); reports.splice(10);
  metrics(report); progress.value = ['cancelled', 'failed'].includes(data.report.outcome) ? 0 : 1;
  status.textContent = `${data.report.error || (data.report.outcome === 'complete' ? 'Prepared · installing GI' : data.report.outcome === 'trial' ? 'Short trial complete · no cache applied' : 'Stopped')} · ${seconds(data.report.totalMilliseconds)} · ${comparison}`;
  element('history').replaceChildren(...reports.map((report, index) => {
    const row = document.createElement('tr');
    for (const text of [`${reports.length - index} · ${report.outcome}`, `${layoutLabels[report.layout]} / ${report.placement}`, `${report.strategy} · ${report.batchSize} / ${report.pauseMilliseconds} ms${report.interactive ? ' adaptive' : ''}`,
      report.warm ? 'Warm' : 'Cold', seconds(report.totalMilliseconds), seconds(report.stages.Transfer ?? 0), `${report.frameGapMilliseconds.toFixed(0)} ms`, report.comparison + (report.progressive ? ' · progressive' : report.streaming && !report.trial ? ' · streamed' : '')]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    return row;
  }));
  element<HTMLButtonElement>('download').disabled = false;
  if (data.atlas && data.sceneData && data.transferBytes) {
    try {
      cancelAnimationFrame(installationRequest);
      completed = { revision, started: runStarted, installationStarted: performance.now(), report };
      installationGap = 0; installationFrame = performance.now();
      preview.apply({ revision, atlas: data.atlas, sceneData: data.sceneData, transferBytes: data.transferBytes });
      installationRequest = requestAnimationFrame(installationHeartbeat);
    } catch (error) { completed = undefined; status.textContent += ' · Preview error: ' + String(error); }
  }
}
const queue = createPreparationQueue<Snapshot, Result>({ prepare, ready: receive,
  error: error => { status.textContent = String(error); } });
function run(trial: boolean, delay = 0) {
  if (!preview || document.hidden) return;
  completed = undefined; cancelAnimationFrame(installationRequest);
  queue.request({ revision, settings: { layout: layout.value as Layout, placement: placement.value as Placement,
    strategy: strategy.value as 'active' | 'reference', batchSize: Number(batch.value), pauseMilliseconds: Number(pause.value),
    interactive: interactive.checked, streaming: streaming.checked, progressive: progressive.checked && streaming.checked && strategy.value === 'active' && !trial, trial } }, delay);
  element<HTMLButtonElement>('stop').disabled = false;
  status.textContent = delay ? 'Layout changed · lighting queued' : 'Starting preparation…';
}
function stop() {
  if (!queue.active) return;
  queue.cancel(); element<HTMLButtonElement>('stop').disabled = true;
  status.textContent = 'Preparation stopped · scene remains available';
}
element('trial').onclick = () => run(true); element('full').onclick = () => run(false); element('stop').onclick = stop;
streaming.onchange = strategy.onchange = () => { progressive.disabled = busy || !streaming.checked || strategy.value !== 'active'; };
element('reset-worker').onclick = () => {
  queue.cancel(); worker?.terminate(); worker = undefined;
  status.textContent = 'Worker reset. The next run will be cold.';
};
element('reset-camera').onclick = () => preview.resetCamera();
function configure(initial = false) {
  queue.cancel(); completed = undefined; cancelAnimationFrame(installationRequest);
  const counts = preview.place(layout.value as Layout, placement.value as Placement, ++revision);
  element('scene-counts').textContent = `${counts.objects} furniture pieces · ${counts.triangles.toLocaleString()} source triangles · ${counts.meshes} meshes · revision ${revision}`;
  status.textContent = 'Scene ready · direct lighting';
  if (!initial && automatic.checked) run(false, 900);
}
placement.onchange = () => configure(); layout.onchange = () => configure();
element('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ recordedAt: new Date().toISOString(), userAgent: navigator.userAgent, reports }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'lighting-preparation-results.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); preview?.pause(document.hidden); });
window.addEventListener('pagehide', () => { queue.dispose(); worker?.terminate(); });
createPreview(element<HTMLCanvasElement>('scene'), base, element('preview-status'), readyRevision => {
  if (completed?.revision !== readyRevision || revision !== readyRevision) return;
  cancelAnimationFrame(installationRequest);
  installationGap = Math.max(installationGap, performance.now() - installationFrame);
  Object.assign(completed.report, { completeGIMilliseconds: performance.now() - completed.started,
    installationMilliseconds: performance.now() - completed.installationStarted, installationFrameGapMilliseconds: installationGap });
  metrics(completed.report);
  status.textContent = `Lighting ready · revision ${readyRevision} · ${seconds(performance.now() - completed.started)} to complete GI · camera preserved`;
}).then(value => {
  preview = value; configure(true); setBusy(false); element<HTMLButtonElement>('reset-camera').disabled = false;
  status.textContent = 'Ready. Start with a short trial; no lighting build has run.';
}).catch(error => { status.textContent = String(error); });
