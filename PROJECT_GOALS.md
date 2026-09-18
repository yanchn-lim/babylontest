# Project goals

Updated: 2026-09-18

## Current focus

Maintain two Babylon implementations:

1. The original apartment viewer at `/`, including its existing navigation,
   baked lighting, probe GI, fixtures, materials and graphics controls.
2. The remake comparison scene at `/comparison.html`, used to evaluate a new
   lighting approach before extending it to the apartment.

Other viewers, retired experiments, their tests and historical reports are
outside scope and have been removed. Keep the two supported implementations
distinct.

## Remake requirements

- Walk around a fixed apartment and change time of day, including night.
- Fixed interior lights have automatic and manual switching. Auto follows time
  of day; On and Off override it.
- Apartment, furniture, material and light-property editing are not required
  for the remake. Existing controls in the original viewer remain supported.
- Aim for convincing realism approaching an offline path-traced render while
  keeping navigation and time changes responsive.
- Keep navigation sharp and stable. Camera movement must not restart lighting
  accumulation. Avoid visible noise, patches, light leaks and heavy blur.
- Offline preparation of lighting data is allowed. No final GI method is selected.

## First milestone: comparison scene

Use a room with a window, a doorway into a darker area, simple objects, neutral
walls, a coloured surface, matte and moderately glossy materials, and fixed lights.
Produce matched offline Cycles references and a real-time Babylon raster version.

Compare matching geometry, camera, material inputs, sun, sky, exposure and display
settings. Assess light distribution, bounced light, colour transfer, shadows,
material response, image stability and time changes separately. Do not fit only
one view or time, or hide lighting errors with per-renderer brightness changes.

The comparison has Room, KLIPPAN and ÄPPLARYD scenes, continuous time controls,
Auto / On / Off lights, walking and saved cameras. The room retains 12 matched
Cycles references and an opacity overlay. Cached dense diffuse transfer is the
only selectable renderer and runs four bounces. Baked lighting remains the
automatic room fallback. Furniture GI requires WebGPU.

At the user's request, old GI, offset, metallic, bounce-count and diagnostic
variants were removed from the comparison. The tested ÄPPLARYD sample correction
is now its normal rendering path. It uses smaller geometric-normal ray offsets
and fills invalid samples from nearby valid samples on the same lighting chart.
Some folds remain unresolved. Other scene caches retain their previous behavior.
This cleanup does not establish a final apartment GI method or phone performance.

The user saved the following visual checkpoints on 2026-09-17:
- `5a0ea1d`: `checkpoint/comparison-2026-09-17`, before shadow/noise refinement.
- `d2b7a18`: `checkpoint/comparison-shadows-noise-2026-09-17`, after filtered
  shadows and the cleaner lightmap bake.
- `37c34f2`: `checkpoint/apartment-diffuse-2026-09-17`, the cached diffuse
  comparison and apartment, before local reflections.
- `d730bc5`: `checkpoint/local-reflections-2026-09-17`, the first local
  reflection implementation, before reflection matching refinements. This is
  the reflection checkpoint. Existing light leaks are accepted for this stage.
- `4ca786b`: `checkpoint/apartment-before-light-balance-2026-09-17`, the local
  state before reducing apartment lamp intensity, including the comparison
  cleanup and the integrated ÄPPLARYD correction.
Preserve these for comparisons and rollback. They do not select the final
apartment GI method. The user also approved the dense direct-ray appearance as
the next visual target. The current prototype reuses its 1,024 fixed ray samples
as exact integer hit weights, with cached diffuse and four bounces as the default.
Earlier cascade implementations remain available in the saved Git checkpoints.

The cache preserves the dense diagnostic within floating-point summation error
in the tested morning and night states. It uses about 84.5 MB of GPU buffers and
texture storage and a 39.3 MB compressed download. These are prototype costs,
not agreed apartment budgets. Visibility is static; regenerate after geometry,
fixture-position, atlas or sampling changes. Visible artifacts, incomplete glossy
reflections and interpolation between baked times remain open. Cycles parity and
phone performance are not established.
See [the comparison guide](docs/remake-comparison.md).

At the user's request, `/apartment.html` now extends the cached dense diffuse
prototype to the fixed apartment. It retains the native materials, adds a padded
lighting atlas, and uses seven fixed room lights with Auto / On / Off controls.
The original viewer remains separate. This extension does not establish Cycles
parity, phone performance or a final GI method. See
[the apartment study guide](docs/apartment-transfer.md).

At the user's request, the remake no longer splits GI geometry at wall
intersections. It uses the original apartment triangles with a regenerated
lighting atlas and transfer cache. Reflection-room partitioning remains separate.
The metallic-texture correction and the KLIPPAN couch comparison are retained.

The prototype adds filtered local reflection probes, initially in the
comparison room and then by apartment room. Reflections use the completed diffuse
lighting, update after lighting changes and stay fixed while walking. They add
only specular lighting; the diffuse cache remains unchanged. An Off control
retains the diffuse-only comparison. Room-probe accuracy and phone costs remain
open; this is not ray-traced reflection or refraction.
The reflection lookup now accounts for the dominant direction of rough GGX
reflections. Material roughness, reflectance, capture resolution and diffuse
lighting remain unchanged. This is a modest approximation improvement, not
path-traced reflection parity.

The apartment now uses 35% of its previous artificial-light intensity for direct
light, cached diffuse bounces and reflection captures. Daylight, exposure and
materials are unchanged. This is the first visual adjustment; window appearance
and remaining loss of surface detail are still open.

At the user's request, the apartment retains its 256×256 GI texture and adds a
small blur to the final indirect lighting. It checks lighting-region boundaries,
surface geometry and brightness differences to preserve corners and contact
shadows. This adds one dispatch per lighting update, with no new GPU buffers.
Comparison scenes and the original viewer retain their existing behavior.

The apartment adds a subtle bloom pass before the existing ACES display transform.
It uses the user-approved strength 0.5, threshold 0.7, kernel 32 and half-resolution filtering, with
4× MSAA. Exposure and reflection capture remain unchanged. This applies only to
normal apartment viewing; offline preparation and comparison scenes are unchanged.
Live bloom strength, threshold and spread controls let the user tune this effect.
Reload restores the initial bloom settings.

The apartment now separates received diffuse light from the receiving material's
colour. Its final shader applies native texture detail and metalness; transport
continues to use the prepared coarse colours. The 256×256 output also masks samples
with more than 75% back-face hits and normalizes the remaining interpolation
weights. This targets false dark seams caused by samples behind adjoining walls.
The cache, bounce count, GPU allocation and nine-dispatch update remain unchanged.
This display correction applies only to the apartment. Comparison scenes, baked
fallback, original viewer, and the separate ÄPPLARYD correction are preserved.
All-invalid interpolation footprints and other GI errors remain unresolved.

At the user's request, editors can use the shared `prepareLightingScene` interface
to generate wall-separated architectural charts, furniture lighting UVs and a
matching dense transfer cache. Preparation keeps native model geometry and
material UVs unchanged. It requires WebGPU and a static preparation scene; it
does not add editing UI to the fixed viewers or replace their existing assets.
See [the shared preparation contract](docs/lighting-scene-interface.md).

Comparison scenes use output dithering at intensity 1/255 to reduce dark-gradient
banding without blurring detail.

## Device and acceptance

The preparation lab at `/preparation.html` is a controlled optimization scene
for editor lighting rebuilds. It uses the real apartment and original APPLARYD,
the shared preparation API and 1,024 rays per active sample.
Manual short trials and full builds compare batch sizes, pacing, warm worker
reuse and cache hashes. It does not start preparation on load. The live prototype now queues
preparation 900 ms after placement changes when automatic preparation is enabled.
This adds a measurement fixture; it does not establish a speedup or change
existing fixed-viewer quality. See [the lab guide](docs/preparation-benchmark.md).

The target is a fully furnished apartment with editing and lighting preparation
running concurrently. Users should enter 3D quickly. This supersedes the earlier
assumption that editing finishes before preparation starts.

Inspected [Injaneity Interior](https://github.com/injaneity/interior/tree/9b9eb48e0a44)
at `9b9eb48e0a44` on 2026-09-18. Its editor debounces edits by 900 ms, cancels
obsolete preparation jobs, rejects stale results, and loads completed results
into a hidden renderer. The initial apartment uses a prepared baseline. Current
3D entry still waits for the latest revision, lighting, reflections and transition
warmup. See `src/render-preparation-queue.js`, `walkthrough/app.js` and
`walkthrough/renderer-entry.js` in that repository.

Interior currently pins renderer `700e160`, before our `d9dd4a9` preparation
optimizations. Each edited build creates and terminates a worker; the integration
does not yet pass a persistent atlas cache, furniture groups or previous layout.
Future preparation work must support responsive editing, safe cancellation and
scene snapshots, and fast 3D entry. The local prototype now also tests progressive
provisional lighting during ray preparation.
The local preparation lab now tests this concurrent flow. Its live viewer shows
direct lighting first and installs complete four-bounce GI from raw bytes without
a scene reload. Revision checks reject stale results; editing clears obsolete GI.
The worker retains completed atlas reuse and adapts transfer batches to page frame
times. Validation, surface rasterization and GPU uploads yield during installation.
The optional stream shows measured skylight and one sun/lamp bounce in bounded
atlas patches, then replaces it with complete filtered four-bounce GI. The worker
waits for each patch acknowledgement. Revisions, cancellation and lighting-state
changes invalidate obsolete patches. Final cache bytes remain unchanged. Atlas
generation must complete before streaming starts; preparation can take longer.
The renderer-side streaming implementation is prepared for integration handoff.
Stream starts include their lighting state, mismatched delayed starts are rejected,
and host state mutation cannot hide a lighting change. Downloaded lab reports keep
first-stream and final-installation measurements. This remains opt-in and local,
not a deployed Interior update.
It omits the stock apartment controls, bloom and reflection probes; production
integration must preserve those paths separately. See
[the integration guide](docs/live-lighting-integration.md).
The local furnished test retained camera control during preparation and GI
installation. A repeated build reused all 20 atlas allocations and matched the
cold cache bytes. Cooperative installation reduced a measured 3.94 s frame stall
to 0.46-0.53 s in individual runs; further hitches remain. Preparation and visible
GI took 32.09 s and 43.32 s on the repeated run. These are local observations,
not phone or production-editor performance guarantees.

Stage one excludes zero-area faces from shared lighting unwrapping and transport
without changing native meshes. The lab adds the failing sofa rotations, a
three-detailed-sofa capacity fixture and a mixed 19-piece baseline (one detailed
sofa plus 18 simple test models). At the user's request, the mixed layout now
uses original IKEA models from Interior's qualified catalogue. Additional models
are limited to 3,000 triangles each, with a 36,178-triangle furniture total across
19 instances including the existing 7,628-triangle sofa. Future furniture
performance tests should use actual IKEA assets and avoid very high triangle
counts. The earlier simple-model timings are historical baselines only.
The actual IKEA chair and cabinet test exposed small valid faces omitted by
xatlas at metre scale. Furniture unwrap inputs now use millimetres near the
origin. Native geometry and ray-tracing geometry remain unchanged in metres.
The real 19-piece IKEA fixture initially exceeded the 128 MiB packed transfer
buffer limit. Cached transfer now splits complete sample rows across GPU buffers
of at most 128 MiB. All connections and 1,024-ray weights remain unchanged, and
each bounce processes every page before the next bounce. The cache file format
and shared preparation API stay unchanged. This fixture completed in 63.41 s
on the local desktop and displayed four-bounce GI using two cache pages with
249.2 MiB of packed entries. Paging removes the single-buffer limit; it does not
reduce total memory or preparation work. Phone performance remains unverified.

At the user's request, generation now reuses completed architecture and furniture
unwraps through an optional worker-owned `LightingAtlasCache`. Shared rigid
placement ancestors are removed only from furniture unwrap inputs; scale,
reflections and internal part transforms remain. Exact geometry changes invalidate
reuse. Allocation retries compute charts once, and CPU ray-hit packing uses
reusable typed counters while preserving entry order and exact weights. Full
lighting transport still rebuilds after each edit. The same 19-piece IKEA fixture
completed in 39.55 s cold and 28.52 s repeated on the local desktop, with atlas
times of 11.85 s and 0.15 s. The repeated cache matched the new cold build exactly.
Canonical UVs can change newly generated sample layouts, so this does not claim
byte equality against older world-space unwraps. Existing prepared assets remain
unchanged. Phone performance and further memory reduction remain open.

The implementation separates the fixed 256×256 architecture region from per-instance
furniture allocations in a rectangular atlas. Stable instance IDs and a previous
layout preserve slots. A versioned cache supports the larger sample addresses;
existing fixed-viewer caches remain compatible. Preparation now traces only
occupied samples, distributes each sample's rays across GPU lanes, and uses
larger paced batches in the shared API. Three detailed sofas fit and produce
identical cache bytes with the reference kernel in the local GPU check. Lighting
proxies remain unimplemented. Individual allocations and cache memory still have
limits; this does not establish arbitrary fully furnished or phone performance.

- Primary target: iPhone 14 Pro, Safari on iOS 26 or newer. Support desktop too.
- Check WebGPU capability and retain the supported WebGL fallback.
- Stable 30 FPS is a provisional target, not a verified result or agreed hard gate.
- Agree on small-scene visuals first, measure on the actual phone, then extend
  the chosen approach to the apartment and difficult interior views.
- Choose preparation and download budgets, time-transition quality and the
  final automatic-light schedule through the small-scene evaluation.
- Keep visual approval separate from numerical checks and device measurements.

## Work discipline

Keep changes within the requested scope. Discuss major rendering changes before
implementation. Perform only minimal, required tests and reviews. A cleanup must
preserve the supported viewers' rendering behavior. Update this document when
requirements or the accepted rendering direction change.
