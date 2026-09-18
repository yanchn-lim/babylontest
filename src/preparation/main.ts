import { createPreview } from './preview';
import { compareResult, type RunReport, type WorkerReply, type WorkerRequest } from './protocol';
import type { Placement } from './fixture';
import { layoutLabels, type Layout } from './furnishings';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'), progress = element<HTMLProgressElement>('progress');
const placement = element<HTMLSelectElement>('placement'), batch = element<HTMLSelectElement>('batch'), pause = element<HTMLSelectElement>('pause');
const layout = element<HTMLSelectElement>('layout'), strategy = element<HTMLSelectElement>('strategy');
const base = new URL(import.meta.env.BASE_URL, location.href).href;
let preview: Awaited<ReturnType<typeof createPreview>>, worker: Worker | undefined, busy = false, id = 0;
let stopping = false, trialRun = false;
let frameGap = 0, previousFrame = 0, frameRequest = 0, runStarted = 0;
const references = new Map<string, string>();
const reports: (RunReport & { frameGapMilliseconds: number; comparison: string })[] = [];
const seconds = (value: number) => (value / 1000).toFixed(2) + ' s';
function setBusy(value: boolean) {
  busy = value;
  for (const name of ['trial', 'full', 'reset-worker', 'layout', 'placement', 'batch', 'pause', 'strategy']) (element(name) as HTMLButtonElement).disabled = value;
  element<HTMLButtonElement>('stop').disabled = !value; element('paused').hidden = !value;
  preview.pause(value || document.hidden);
}
function heartbeat(now: number) {
  if (!busy) return;
  if (previousFrame) frameGap = Math.max(frameGap, now - previousFrame);
  previousFrame = now; frameRequest = requestAnimationFrame(heartbeat);
}
function metrics(report: RunReport) {
  const t = report.timings;
  const values: [string, string][] = [['Total', seconds(report.totalMilliseconds)], ...Object.entries(report.stages).map(([name, ms]): [string, string] => [name, seconds(ms)])];
  if (report.counts) values.push(['Furniture pieces', String(report.counts.objects)], ['Source triangles', report.counts.triangles.toLocaleString()]);
  if (report.ignoredTriangles !== undefined) values.push(['Zero-area faces excluded', String(report.ignoredTriangles)]);
  if (report.atlasHeight) values.push(['Lighting atlas', `256 × ${report.atlasHeight}`]);
  if (report.atlasBuilds !== undefined) values.push(['Atlas builds / reused', `${report.atlasBuilds} / ${report.atlasCacheHits}`], ['Packing attempts', String(report.packingAttempts)]);
  if (report.error) values.push(['Failure', report.error]);
  if (t) values.push(['GPU + readback wait', seconds(t.readbackMilliseconds)], ['CPU hit packing', seconds(t.packingMilliseconds)],
    ['Dispatch / compilation', seconds(t.dispatchMilliseconds)], ['Intentional pauses', seconds(t.pauseMilliseconds)],
    ['Largest batch', seconds(t.maxBatchMilliseconds)], ['Work items processed', t.processedSamples.toLocaleString()], ['Total atlas slots', t.atlasPixels.toLocaleString()],
    ['Active samples processed', t.activeSamples.toLocaleString()], ['Ray readback', (t.readbackBytes / 1048576).toFixed(1) + ' MiB']);
  values.push(['Largest page frame gap', frameGap.toFixed(0) + ' ms']);
  element('metrics').replaceChildren(...values.flatMap(([name, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd];
  }));
}
function finish() { cancelAnimationFrame(frameRequest); frameGap = Math.max(frameGap, previousFrame ? performance.now() - previousFrame : 0); setBusy(false); stopping = false; }
function receive({ data }: MessageEvent<WorkerReply>) {
  if (data.id !== id || !busy) return;
  if (data.type === 'progress') {
    progress.value = Math.min(1, trialRun && data.stage === 'Transfer' && data.timings ? data.timings.processedSamples / 4096 : data.fraction);
    if (!stopping) status.textContent = `${data.stage} · ${Math.round(progress.value * 100)}% · ${seconds(performance.now() - runStarted)}`;
    return;
  }
  finish();
  if (data.type === 'error') { status.textContent = data.message; return; }
  const comparison = compareResult(data.report, references);
  reports.unshift({ ...data.report, frameGapMilliseconds: frameGap, comparison }); reports.splice(10);
  metrics(data.report); progress.value = ['cancelled', 'failed'].includes(data.report.outcome) ? 0 : 1;
  status.textContent = `${data.report.error || (data.report.outcome === 'complete' ? 'Full build complete' : data.report.outcome === 'trial' ? 'Short trial complete · no cache applied' : 'Stopped')} · ${seconds(data.report.totalMilliseconds)} · ${comparison}`;
  element('history').replaceChildren(...reports.map((report, index) => {
    const row = document.createElement('tr');
    for (const text of [`${reports.length - index} · ${report.outcome}`, `${layoutLabels[report.layout]} / ${report.placement}`, `${report.strategy} · ${report.batchSize} / ${report.pauseMilliseconds} ms`,
      report.warm ? 'Warm' : 'Cold', seconds(report.totalMilliseconds), seconds(report.stages.Transfer ?? 0), `${report.frameGapMilliseconds.toFixed(0)} ms`, report.comparison]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    return row;
  }));
  element<HTMLButtonElement>('download').disabled = false;
  if (data.atlas && data.sceneData && data.gzip) {
    try { preview.apply(data.atlas, data.sceneData, data.gzip); }
    catch (error) { status.textContent += ' · Preview error: ' + String(error); }
  }
}
function run(trial: boolean) {
  if (busy || document.hidden) return;
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); worker.onmessage = receive;
    worker.onerror = event => { finish(); status.textContent = event.message || 'Preparation worker failed.'; worker?.terminate(); worker = undefined; };
  }
  trialRun = trial; stopping = false;
  setBusy(true); frameGap = 0; previousFrame = 0; runStarted = performance.now(); progress.value = 0;
  status.textContent = 'Starting preparation…'; frameRequest = requestAnimationFrame(heartbeat);
  const request: WorkerRequest = { type: 'run', id: ++id, base, settings: { layout: layout.value as Layout, placement: placement.value as Placement,
    strategy: strategy.value as 'active' | 'reference', batchSize: Number(batch.value), pauseMilliseconds: Number(pause.value), trial } };
  worker.postMessage(request);
}
function stop() { if (busy) { stopping = true; worker?.postMessage({ type: 'cancel' } satisfies WorkerRequest); status.textContent = 'Stopping after the pending GPU batch…'; element<HTMLButtonElement>('stop').disabled = true; } }
element('trial').onclick = () => run(true); element('full').onclick = () => run(false); element('stop').onclick = stop;
element('reset-worker').onclick = () => { worker?.terminate(); worker = undefined; status.textContent = 'Worker reset. The next run includes loading.'; };
element('reset-camera').onclick = () => preview.resetCamera();
function configure() {
  const counts = preview.place(layout.value as Layout, placement.value as Placement);
  element('scene-counts').textContent = `${counts.objects} furniture pieces · ${counts.triangles.toLocaleString()} source triangles · ${counts.meshes} meshes`;
  status.textContent = 'Layout changed. Start a trial or full build when ready.';
}
placement.onchange = configure; layout.onchange = configure;
element('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ recordedAt: new Date().toISOString(), userAgent: navigator.userAgent, reports }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'lighting-preparation-results.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); preview?.pause(busy || document.hidden); });
createPreview(element<HTMLCanvasElement>('scene'), base, element('preview-status')).then(value => {
  preview = value; configure(); setBusy(false); element<HTMLButtonElement>('reset-camera').disabled = false;
  status.textContent = 'Ready. Start with a short trial; no lighting build has run.';
}).catch(error => { status.textContent = String(error); });
