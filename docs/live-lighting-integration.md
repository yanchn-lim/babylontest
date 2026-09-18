# Live lighting integration for Interior

Approved display and reflection changes now use shared defaults across all active
viewers. See [the current graphics policy](../PROJECT_GOALS.md#shared-graphics-defaults).
The original viewer is retired; `/` opens the current apartment.

This opt-in local implementation lets users explore the current geometry while a separate
worker prepares lighting. Completed GI installs into the same scene, without a
GLB reload or a camera reset. The optional stream now displays provisional
indirect lighting while ray preparation is still running.

Test `/preparation.html` with **IKEA furnished · 19 pieces**. Placement changes
queue a full build after 900 ms. Navigation and placement controls remain active.
The initial page load does not start a bake. Stop cancels preparation; an edit
also removes the previous geometry revision's GI immediately.

## Architecture boundaries

The preparation lab now calls `partitionLightingArchitecture` once during
architecture loading, on both its worker and viewer copies. Integrators must
make the same call before preparation and before returning display meshes from
`loadScene`. It adds triangle edges at opaque wall intersections so the atlas can
separate indoor and outdoor light. Furniture is excluded. This changes vertex
counts: rebuild the atlas and transfer, and preserve the matching geometry in
exports and reflection mappings. Keep both copies in the same mesh order and
world transforms. See [the helper contract](lighting-scene-interface.md#wall-intersections).
Do not repeat this operation for furniture placement changes. Cold preparation
and triangle counts increase; the atlas cache retains the completed unwrap.

## Renderer interfaces

- `src/apartment/live-viewer.ts`: `createLiveViewer(canvas, loadScene, callbacks)`.
  Creates the tested WebGPU direct-light viewer. `loadScene(scene)` imports the
  geometry and native PBR materials and returns `{ meshes, settings }`, where
  settings contains the preparation fixture, sky and camera-view inputs. The
  promise resolves after scene readiness and its first rendered frame, without
  waiting for an atlas or transfer data.
- `viewer.reset(revision, meshes)`: adopt the current geometry snapshot, clear
  obsolete GI, initialize render-only triangle-corner UV slots and update shadow
  casters. Revisions must be increasing safe integers. The host owns replacing,
  disabling and disposing obsolete geometry. Pass source meshes in the same
  import order used by the isolated preparation scene. Do not pass reflection
  partition output as if it were the original source meshes.
- `viewer.beginStream({ revision, atlas, sceneData, lighting, checkpoints? })`: validate the matching
  geometry and install its atlas with an empty provisional texture. Call after
  `prepareLightingScene.onAtlasReady`; it does not wait for ray preparation.
  `lighting` is `{ state, fixtureIntensityScale }`, exactly as passed to
  `transferOptions.preview`. A delayed start returns false if its lighting state,
  sky or fixture scale no longer matches the viewer. Continue acknowledging its
  ignored patches, or abort that stream's preparation job.
- `viewer.updateStream({ revision, sequence, firstRow, pixels, fraction })`:
  apply one provisional texture region. Returns false for stale revisions,
  duplicates, cancelled streams and patches arriving after final installation
  starts. Missing sequence numbers, invalid bounds and non-finite values throw.
- `viewer.applyCheckpoint({ revision, rays, offsets, entries, visibility })`: with
  `checkpoints: true`, await a complete 64-, 128-, 256- or 512-ray four-bounce image.
  Returns false for a stale revision; cancellation during installation rejects.
  Call in increasing ray order and await each call before sending another.
- `viewer.cancelStream(revision)`: remove provisional and checkpoint lighting for that revision.
  Editing must still call `reset` with an increased revision.
- `viewer.apply({ revision, atlas, sceneData, transferBytes })`: accepts a complete
  result, with raw `ArrayBuffer` bytes. Returns false for an obsolete revision.
  Synchronous input errors throw. Atlas coordinates, vertex counts, world-space
  positions and fixture settings are checked; cache decoding verifies the scene
  and shader fingerprint. The host must advance revisions for material, topology,
  transform and other preparation-input changes, even when vertex counts match.
- `viewer.diagnostics()`: scene revision, phase (`preview`, `streaming`, `refining`, `installing`,
  `ready` or `error`), stream update count/fraction, error text, uploaded bytes and
  transfer diagnostics.
- `callbacks.onReady(revision)`: emitted once after the final 1,024-ray four-bounce result is
  published. Intermediate checkpoints do not trigger this callback. This is lighting readiness, not geometry readiness. Use it to start
  dependent work such as reflection refreshes, without gating navigation.
- `viewer.pause(boolean)`, `resetCamera()` and `dispose()` control lifecycle.
  `viewer.scene`, `engine` and `camera` are available to the host adapter.

The viewer uses the apartment's 0.35 fixture-intensity scale, received diffuse
material response, four bounces and filtered final GI. This prototype fixes time
to 09:00 with fixtures on, matching the preparation lab. It does not include the
stock apartment's time/settings UI, bloom or reflection probes. It is not a drop-in
visual replacement for `src/apartment/main.ts`. Keep the authored baseline path
and existing WebGL fallback. Port the live lifecycle to the production apartment
entry, including its existing controls and reflection mesh mapping, before
claiming production viewer parity. No Interior code or hosted site is changed by
this prototype.

`LiveLighting` in `src/apartment/live-lighting.ts` is the lower-level component
for that production entry. It exposes `basis` for `ApartmentLightmap`, `reset`,
`beginStream`, `updateStream`, `applyCheckpoint`, `cancelStream`, `apply`, `setLighting`, `tick`,
`diagnostics` and `dispose`. Call `tick()` before
rendering. Use its `basis` on all relevant material plugins. Keep a permanent
black fallback texture on the material while `basis.ready` is false. Preserve
the original source-to-render vertex mapping if reflection partitioning changes
the display meshes. Installing an atlas before partitioning and throwing away
the source mapping is not sufficient for later updates.

## Local completion and handoff scope

The renderer-side stream, worker protocol and preparation lab are implemented.
This is an integration candidate, not a deployed change to Interior. The existing
fixed apartment and comparison viewers retain their own startup paths. The live
viewer now uses the normal apartment's direct-shadow settings; additional shadow
quality changes are outside this streaming handoff.

The final sequence is: display geometry/direct light; finish the atlas; apply
acknowledged provisional patches; publish optional 64-, 128-, 256- and 512-ray
four-bounce checkpoints; install the complete raw cache; publish the final
filtered four-bounce result. The camera and scene stay alive throughout. Do not
make 3D entry wait for the last step. Keep scene revision and job ID checks in the
host: retrying a job can reuse a scene revision, but an older job must not publish.

Download results from the lab to retain streaming mode, first patch time, patch
count, worker preparation time, complete-GI time, installation time and frame gaps.
Completion/installation fields appear only after final GI is ready. Idle page
visibility changes no longer replace the completed status with a stop message.
The Stop button cancels queued/running preparation, not a completed cache that is
already installing. Edits invalidate and dispose pending installation through
`viewer.reset`. Dispose the viewer when its host is destroyed.

The integration must still preserve production time/settings controls, reflection
updates, authored baseline loading and the WebGL fallback. Test the iframe relay,
exports and phone performance in Interior before treating that integration as
production-ready. Streaming improves early feedback, but adds work and does not
reduce final cache memory; temporary coarse lighting and frame hitches remain.

## Changes in Interior

Inspected Interior `9b9eb48e0a44`, with renderer submodule `700e160`. These changes
must be built into both GitHub and the Sites checkout when integration is ready.
This renderer commit supplies the interfaces; it does not deploy Interior.

1. Update the renderer submodule to a revision containing the preparation
   optimizations and these interfaces. Use the same revision for preparation
   and display. Keep the Babylon versions matched.
2. In `walkthrough/prepare-renderer-glb.js`, separate the existing geometry export
   from lighting preparation. Export one immutable GLB snapshot for a revision.
   Load those geometry bytes in the viewer and import the same snapshot in the
   worker. Retain original appearance templates and furniture ownership metadata.
3. In `walkthrough/renderer-entry.js`, add a live entry path for edited geometry.
   The current path expects embedded lighting resources and starts the stock
   apartment entry; a geometry-only GLB cannot simply be passed through it.
   Use the live viewer for prototype integration, or integrate `LiveLighting`
   into the full apartment entry for production parity.
4. In `walkthrough/app.js`, enable 3D when the current revision reports geometry
   readiness. Do not wait for GI or reflections. Keep the current entrance camera
   placement/transition, but remove lighting readiness from its entry condition.
   Preserve the fast, fully prepared authored baseline on first load.
5. Retain the queue's 900 ms debounce, cancellation and stale-result checks.
   Separate scene revision from preparation job ID. A retry can use the same
   scene revision; only the latest job may publish. Keep at most one running
   preparation and the newest pending snapshot.
6. In `walkthrough/prepare-worker-client.js`, keep a worker alive across completed
   jobs. In `prepare-worker.js`, keep `LightingAtlasCache` and the previous
   completed layout outside the job handler. Do not alter the preparation scene
   while its job is active. Pass an abort signal and stable furniture groups to
   `prepareLightingScene`. A group ID identifies a placed instance, not a product.
7. Send the raw result as a separate revision-tagged message. Keep the iframe
   alive when lighting arrives. Reject wrong origins, wrong source windows,
   stale scene revisions and obsolete job IDs before forwarding or installing.
   If geometry is still loading, retain only the newest matching result.
8. Remove gzip and GLB lighting packaging from the viewing path. Keep the
   existing complete-file export path for downloads until result ownership for
   export is implemented. A downloadable GLB still needs matching geometry,
   atlas, scene JSON, gzip cache and fallback resources. Never attach an older
   result to a newer geometry revision.

The lab's `src/preparation/{queue,main,worker,protocol}.ts` provides a working
reference for queueing, worker reuse, cancellation, progress and raw handoff.
It uses a fixed fixture description rather than arbitrary editor GLB input.

## Minimal prototype bootstrap

This belongs in the renderer iframe, using the same exported snapshot as the
preparation worker. The existing navigation helper requires `#move-stick` and
`#stick-thumb` elements in addition to the canvas. The input must contain static
concrete Babylon meshes with native PBR materials, in metres.

```ts
import { Mesh, PBRMaterial } from '@babylonjs/core';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { createLiveViewer } from '../third-party/babylontest/src/apartment/live-viewer';

let meshes: Mesh[] = [];
const viewer = await createLiveViewer(canvas, async scene => {
  const imported = await ImportMeshAsync(geometryGlbUrl, scene);
  meshes = imported.meshes.filter((mesh): mesh is Mesh =>
    mesh instanceof Mesh && mesh.getTotalVertices() > 0 && mesh.material instanceof PBRMaterial);
  return { meshes, settings };
}, {
  onReady: revision => reportLightingReady(revision),
  onStatus: text => showLightingStatus(text),
});
viewer.reset(sceneRevision, meshes);
reportSceneReady(sceneRevision); // Enable 3D here.

// After checking message origin, source, job ID and current scene revision:
viewer.apply({ revision: sceneRevision, atlas, sceneData, transferBytes });
```

The `geometryGlbUrl`, `settings`, revision and reporting functions are host
inputs, not globals supplied by this library. Do not enable the preparation
loader's `useSRGBBuffers: false` on the display scene; that setting is only for
the isolated CPU material-readback path.

## Streaming provisional lighting

The preparation worker can opt in without changing the final cache format:

```ts
import { lighting } from '../third-party/babylontest/src/comparison/lighting';

const previewLighting = { state: lighting(9, 'on'), fixtureIntensityScale: .35 };
const prepared = await prepareLightingScene({
  ...snapshotInputs,
  onAtlasReady: (atlas, sceneData) => sendStreamStart({ jobId, revision, atlas, sceneData, lighting: previewLighting }),
  transferOptions: {
    ...schedulingOptions,
    preview: {
      ...previewLighting, // Must match the displayed lighting state.
      onChunk: chunk => sendPatchAndWaitForViewerAck({ jobId, revision, ...chunk }),
    },
  },
});
// Send the complete prepared result through the existing raw result path.
```

The send functions above are host adapters. See `src/preparation/worker.ts` and
`main.ts` for the implemented acknowledgement protocol. Forward `stream-start`
to `viewer.beginStream`, then each `stream-chunk` to `viewer.updateStream`.
Transfer `pixels.buffer` rather than copying it. Acknowledge the sequence after
the viewer consumes the patch; only then may the worker send the next patch.
The lab waits for at most one acknowledgement at a time. Abort must reject that
wait. A relay through an iframe must wait for the iframe's acknowledgement,
not acknowledge when the parent merely receives the message. Check origin,
source window, job ID and scene revision at each boundary. Ignore obsolete
messages; acknowledge or abort an obsolete sender so it cannot remain blocked.

`pixels` is a Float32 RGBA rectangle, 256 pixels wide and at most 64 rows high.
`firstRow` is its vertical atlas offset, not a mesh index. `sequence` starts at
one and must increase by one. `fraction` is preparation progress, not a promise
that the same fraction of visible screen pixels is lit. One patch is at most
256 KiB. Updates are emitted approximately every 400 ms, with multiple bounded
patches when a range spans more than 64 rows. At most one patch is awaiting acknowledgement while the
viewer is busy. This bounds message backlog, not total memory or GPU time.

Before rays are prepared, a small pass computes shadowed sun and lamp radiance
on all surfaces. Each finished ray batch then supplies measured sky visibility
and one bounce of that sun/lamp radiance. The preview reuses the same 1,024 rays
and packed hit weights as the final cache. It omits bounced skylight, later
bounces and final filtering. Mostly back-facing receiving samples use the same
validity threshold as the final renderer. Unfinished regions have zero indirect
light and retain the direct-light preview. Regions appear in atlas order; this
is not a uniform whole-scene fade or a final-quality progressive path tracer.
Temporary boundaries and brightness changes are expected until completion.

Atlas generation must finish before the first patch. Source-light preparation,
extra readback, packing and uploads add work; streaming improves time to visible
indirect lighting, not necessarily total preparation time. It retains provisional
CPU/GPU textures during final installation, so peak memory is higher.

The current live viewer fixes time at 09:00 with lights on. The lower-level
`LiveLighting.setLighting` clears an active provisional stream when lighting
inputs change. It copies the supplied state and sky, so reusing a mutable host
settings object does not hide later changes. Late patches are then ignored; the complete cache still installs
using the new lighting state. Hosts that need a new provisional stream must
cancel and restart its job with those inputs. The opt-in preview rejects legacy
`sampleRepair` scenes; normal preparation and their completed caches remain
supported when preview is omitted. The lab disables streaming for short trials.

## Scheduling and memory

### Optional whole-scene refinement

Set `transferOptions.preview.progressive: true` with the active-sample kernel
to refine every active lighting sample through 64, 128, 256, 512 and 1,024 total rays.
The lab enables this with **Refine whole scene**. Uncheck it to compare the
previous regional stream. Short trials and the reference kernel do not enable
refinement. Legacy sample-repair profiles remain unsupported by the preview.

The passes add 64, 64, 128, 256 and 512 new rays respectively, for 1,024 total.
The atlas and the final 1,024 ray directions stay fixed. The first passes visit
spread-out subsets; subsequent passes trace only the remaining directions.
Compact hit counts and earliest original ray indices survive between passes.
Consumed partial blocks are released as the next pass advances. This adds
temporary CPU memory and merging work, but does not retain every raw ray result
or perform five separate complete bakes. Final entries return to original
first-hit order, preserving the existing cache format and fingerprint.

Patches use the same acknowledgement and revision protocol. Optional
`raysPerSample` identifies the current pass (64, 128, 256, 512 or 1,024); a patch can include
neighbouring rows still at the preceding quality. `fraction` counts completed
ray work, so full passes reach 6.25%, 12.5%, 25%, 50% and 100% respectively.
Coverage means the samples were evaluated; invalid receiving samples still have
zero alpha. Early patches retain measured sky and one sun/lamp bounce. With
`onCheckpoint`, full four-bounce GI replaces these patches after the first pass.
The final cache still installs once, after the last pass.

Early passes process more surface samples within the configured ray budget,
up to 4,096 surfaces per batch. A scheduled batch of 512 therefore represents
the ray budget of 512 full-quality samples, not always 512 surfaces. Reports
include cumulative pass completion times measured from transfer preparation
start (including surface/source preparation). Atlas generation still precedes
the first pass. Lower-sample lighting can fluctuate, and this mode targets earlier
whole-scene feedback rather than a guaranteed reduction in total bake time.

### Early full-lighting checkpoints

The lab enables these with whole-scene refinement. At atlas readiness, pass
`checkpoints: true` to `viewer.beginStream`. This prepares geometry, static GPU
buffers and shaders while the worker traces its first pass. Add this callback:

```ts
preview: {
  ...previewLighting,
  progressive: true,
  onChunk: chunk => sendPatchAndWaitForViewerAck({ jobId, revision, ...chunk }),
  onCheckpoint: checkpoint => sendCheckpointAndWaitForViewerAck({
    jobId, revision, ...checkpoint,
  }),
}
```

A checkpoint contains `rays: 64 | 128 | 256 | 512`, atlas-wide `offsets: Uint32Array`,
packed `entries: Uint32Array`, and `visibility: Float32Array`. These are transient
partial transport data, not a final cache file. Transfer the three buffers to
the viewer without JSON conversion. After checking origin, source, job ID and
scene revision, the viewer-side handler is:

```ts
await viewer.applyCheckpoint({ revision, rays, offsets, entries, visibility });
acknowledgeCheckpoint(jobId, rays);
```

The lab protocol uses `checkpoint` and `checkpoint-ack` messages. The worker
waits until the four-bounce image is published before starting the next pass.
Keep rendering while awaiting the promise; `LiveLighting.tick()` advances it.
An obsolete message may return false; acknowledge it only for its original job,
or cancel that job. Handle rejection during cancellation without failing the
newer job. Never send the final result while a checkpoint is still installing.

Each checkpoint uses its actual ray count for normalization, the same four
bounces (including bounced sky), receiving-sample rejection and final filter.
The previous completed image stays visible until the new image is complete.
After the first checkpoint is acknowledged, preparation stops calculating and
sending one-bounce patches. The viewer also rejects late patches, so they cannot
overwrite better lighting.
The viewer reuses static GPU buffers and shaders; it replaces the growing
transport buffers. `viewer.apply(finalResult)` reuses that prepared renderer.
Final decoding still requires the original 1,024-ray format and fingerprint.

This moves the change in lighting model to the 64-ray stage. Sampling noise,
small-face validity and shadow detail can still change at later stages. It does
not guarantee an invisible final transition. Each checkpoint adds a CPU copy,
validation, transport upload and four-bounce calculation. Two output textures
keep updates atomic. Final cache memory is unchanged; peak memory and phone
performance still need measurement. Reports include checkpoint visibility times
from run start, separately from worker ray-coverage times.

### Refinement work reuse

With progressive checkpoints, the first 64-ray pass retains its sequential
preview stream. After its checkpoint callback resolves, the worker releases the
preview state. The 128-, 256-, 512- and 1,024-ray passes then alternate two ray-result
buffers: batch B starts before the CPU packs batch A. There is at most one batch
ahead of CPU packing. Batch order and original hit ordering remain unchanged.
Configured pauses remain, and cancellation drains the one submitted read before
disposing its buffers. A worker termination still uses the host's existing
cancellation timeout.

Checkpoint installation retains per-sample hit totals from validation. It uses
these totals for the receiving-sample mask instead of scanning all connections
again. Validation and atlas preparation check a 4 ms CPU work budget between
small blocks; they no longer sleep after every fixed block of empty atlas slots.
GPU uploads retain their existing bounded writes and yields.

No new host option is required. Existing callers without `onCheckpoint` keep
all their provisional passes and sequential preparation. Checkpoint publication
still blocks the next ray pass; overlapping checkpoint installation is separate
work. GPU hit packing is also unchanged. The extra GPU result buffer is
`batchSize * 1024 * 4` bytes (2 MiB for the measured 512-sample setting), plus
bounded readback storage. This does not reduce final-cache memory.

Reports expose `pipelinedBatches` and `previewSamples`. `readbackMilliseconds`
measures time awaiting results that CPU work has not hidden, rather than total
GPU execution time. Overlapped batch durations can overlap each other and must
not be summed to infer total time. The ray readback byte count is unchanged.

### Preparation pacing

`prepareLightingScene` accepts `transferOptions.schedule`, a callback read
between ray batches. Return `{ batchSize, pauseMilliseconds }`. Batch size must
be a multiple of 64, no larger than the initial allocated batch; pause must be
0–100 ms. Existing callers without this callback keep their fixed schedule.

The lab sends the maximum animation-frame gap every 250 ms. Its interactive
policy caps batches at 512 samples, or 128 when that gap exceeds 24 ms, and waits
at least 8 or 32 ms respectively. These are prototype settings, not a device
guarantee. The GPU is shared with rendering and the desktop; a worker does not
reserve GPU time. Synchronous atlas work and submitted GPU dispatches cannot be
interrupted mid-operation. The lab terminates an unresponsive cancelled worker
after 1.5 seconds; that loses its atlas cache and requires a cold worker restart.

Raw cache buffers use transferable ownership, not JSON or base64. Do not mutate
or transfer the buffer away while the receiving viewer is loading it. Handoff
from worker to parent and then parent to iframe can each transfer ownership.
Keeping a second export copy adds approximately the full raw cache size to memory.

`CachedTransfer` accepts its original gzip URL, a raw `ArrayBuffer`, or `null`
for checkpoint preparation. The live component owns the checkpoint lifecycle.
Its optional final argument controls `uploadChunkBytes` and `onUpload(bytes)`.
The live component uploads at most 4 MiB per write and yields between writes;
validation, surface rasterization and validity-mask loops also yield. It still
allocates all final GPU buffers. Chart identification, BVH construction and some
CPU loops remain synchronous. Bounded writes do not bound total memory or guarantee a frame-time ceiling.

Provisional GI remains visible during final cache validation and upload. The
final texture replaces it only after all four bounces finish. A failed result
leaves the direct-light preview usable. The atlas, 1,024-ray sampling, cache layout and complete-file export format retain
their current contracts.

## Checks before production integration

- Delay or fail preparation: current geometry must still enter 3D.
- Edit during atlas work, transfer and installation: only the newest revision
  can become visible. Test rapid edits, undo/redo, Stop, retry and worker restart.
- Move the camera during preparation and installation: preserve its position
  and orientation after GI arrives.
- Compare complete output with the existing renderer for matched settings,
  including night, material textures and reflections after production integration.
- Measure first usable 3D frame, preparation time, installation time, frame gaps
  and peak memory separately on desktop and the target phone.
- Verify exported files and the authored baseline/WebGL fallback separately.
