# Lighting preparation lab

Open `/preparation.html`, or select **Preparation lab** in the comparison scene.
This is a local optimization fixture for the shared `prepareLightingScene` API.
It loads the apartment, the original 7,628-triangle APPLARYD, and low-triangle
IKEA products selected from Interior's current qualified catalogue. It does not
export a GLB or reproduce the editor UI.

The layout menu now includes one, two and three detailed sofas, plus a furnished
19-piece layout. The furnished layout now uses real IKEA GLBs: the original
APPLARYD plus LACK and LISABO tables, LISABO chairs, SLATTUM bed frames, MALM
drawers, KLEPPSTAD wardrobes, BESTÅ cabinets and a VIHALS cabinet. The nine
additional products contain 448–2,988 triangles each; repeated instances bring
the furniture total to 36,178 triangles. Geometry, textures and materials are
retained. These are actual visible models, not generated lighting proxies.
See `public/preparation/ikea/manifest.json` for exact articles, URLs and hashes.
Three detailed sofas fit separate allocations.
Failed runs remain in history and downloaded reports.

The real LISABO chair and VIHALS cabinet exposed valid sub-millimetre faces that
xatlas omitted at metre scale. Furniture unwrap inputs now use millimetres near
the origin; source and transport geometry keep their original size. This keeps
small faces instead of replacing models or silently deleting detail. The manual
`/tests/ikea-atlas.browser.html` check covers each selected product separately.

The first sofa has 30-degree and 135-degree regression placements. Its five
zero-area source triangles previously caused collapsed-UV failures at these
rotations. Preparation now excludes those faces without changing native meshes
or returned UV ordering. A completed run reports the excluded face count.

See [live lighting integration](live-lighting-integration.md) for the new
renderer entry, revision protocol and Interior integration steps. This remains
a local prototype; it does not update the deployed editor.

## Controlled comparison

1. Start with a **Short trial**. It stops after 4,096 work items: active samples
   for the active kernel, or atlas slots for the reference kernel. These workloads differ.
   A trial produces timings, not a usable lighting cache.
2. Repeat with the same placement and settings for a warm measurement.
3. Change the kernel, batch size or pause. The lab defaults to the active kernel,
   a 1,024-sample allocation and an 8 ms minimum pause. Adaptive scheduling is
   enabled by default; actual batches are capped at 512 or reduced to 128 when
   frame times rise. Disable it for fixed-schedule comparisons.
4. Use **Build full lighting** to cover all active samples. Completed data is
   decoded and validated before it is displayed with four diffuse bounces.
5. Repeat full builds for the same input. **Exact match** means the SHA-256
   hashes of the uncompressed cache bytes match. **MISMATCH** means investigate
   correctness before adopting that setting. A new input gets a new reference.
6. Download the most recent ten reports as JSON. Reset the worker to measure
   model loading again. This does not clear the browser's HTTP or shader caches.

The ray count stays at 1,024 per active sample. Architecture retains a 256×256
region; furniture instances use separate allocations in a growing rectangular
atlas. The active kernel shares each sample's rays across 64 GPU lanes and skips
empty atlas slots. Both kernels use the same ray directions and hit weights.
Larger batches reduce dispatch/readback count but can make each GPU job longer.
Pauses add wall time and can give other work time to run. Neither setting is
assumed to improve performance until measured on the target device.

The preview remains interactive during preparation. The worker, GPU engine, model and bounded
atlas cache stay loaded between runs. Materials and transfer are rebuilt; exact
unchanged unwrap inputs reuse completed UVs. A completed
layout preserves instance slots. Allocation retries compute charts once and
repeat only packing. Sofa placement
changes clear the preview's old GI and queue a build after 900 ms when automatic
preparation is enabled. Hiding the page requests cancellation. Stop takes effect
after the current GPU batch; it cannot interrupt an already submitted dispatch.
If the worker cannot acknowledge cancellation within 1.5 seconds, the host
terminates it. That releases its atlas cache and requires a cold restart.

## Measurements and limits

The furnished fixture's LISABO chair (10457230) is the original black variant.
Its base-colour texture has median RGB values of 12/255, with 95th-percentile
values of 14/255. A full-scene diagnostic found nonzero received diffuse light
on more than 99% of each chair's valid lighting samples. Changing only the
displayed base colour to neutral grey exposes the shading under the same cache.
The lab omits environment reflections, so very dark finishes can appear flat
black. This observation does not validate every individual chair sample or
establish final material appearance. The temporary material-comparison diagnostic
was removed after this check; the original fixture materials remain unchanged.

- Loading, Materials, Atlas, Transfer and Validation are wall times. The live
  viewer receives raw bytes; compression is no longer part of this path. Older
  measurements below include compression and a paused preview.
- Readback includes GPU execution, driver waits and copying. It is not a GPU
  timestamp query or a measurement of GPU utilization.
- Dispatch includes first-use compilation waits. CPU hit packing measures the
  JavaScript aggregation after each ray readback. Pauses report elapsed waits.
- Ray readback bytes exclude the final visibility readback and packed cache.
- Largest page frame gap uses `requestAnimationFrame` while the preview renders.
  It does not measure other applications or prove the PC stays smooth. The page
  also reports installation time, installation frame gap and time to visible GI.
- Short trials cover one atlas region. Do not extrapolate their speed to the
  full scene, or compare their totals with full builds.
- Total time ends in the worker before posting the result. Main-thread cloning,
  loading the result into the viewer, and final display are outside that time.
- The preview shows direct lighting until a full build succeeds. It omits
  reflection probes and bloom and is not a final visual reference.

The shared API accepts optional `transferOptions` with `batchSize` (multiples
of 64 from 64 to 4096), `pauseMilliseconds` (0 to 100), `strategy` (`active` or
`reference`), `onBatch(timings)` and an optional `schedule()` callback read
between batches. A scheduled batch cannot exceed the allocated batch size. Shared API defaults are 1024/8 with the active
kernel. The lab uses this
hook to measure and stop trials; cancellation never returns a partial cache.

## Atlas reuse and typed hit packing, 2026-09-18

The worker now retains a `LightingAtlasCache`. Furniture unwraps exclude common
rigid placement ancestors, so duplicate models and moved or rotated instances
can reuse UVs while retaining scale, reflections and internal part transforms.
Unchanged architecture also reuses its atlas. The cache is bounded to 64 keys,
hashes exact unwrap inputs, and returns copies. Changed geometry and applicable
transform changes miss the cache. Transport is rebuilt for every full run.

Allocation retries now compute charts once, then repeat packing for larger
sizes. CPU hit packing uses reusable typed arrays in the same first-hit order
as the previous Map-based implementation, without changing integer weights.

On the same 19-piece actual IKEA fixture, active kernel, batch 1,024 and 8 ms pause:

| Measurement | Before, cold | Optimized, cold | Optimized, repeat |
| --- | ---: | ---: | ---: |
| Full preparation | 63.41 s | 39.55 s | 28.52 s |
| Atlas | 28.83 s | 11.85 s | 0.15 s |
| Transfer | 27.47 s | 20.62 s | 22.01 s |
| CPU hit packing, part of transfer | 10.19 s | 3.72 s | 3.90 s |
| GPU + readback, part of transfer | 12.54 s | 12.12 s | 13.79 s |
| Compression | 4.88 s | 4.75 s | 4.86 s |
| Atlas builds / reused allocations | Not recorded | 11 / 9 | 0 / 20 |
| Packing calls | Not recorded | 310 | 0 |
| Largest page frame gap | 80 ms | 96 ms | 84 ms |

The cold build took about 38% less total time; atlas generation took about 59%
less time, and CPU packing about 63% less time. These are individual desktop
runs, not isolated per-change timings or phone measurements. Browser frame gaps
did not improve in these runs. Timing excludes applying the result in the viewer.

Both optimized builds decoded successfully and displayed fresh four-bounce GI
with two cache pages and 249.0 MiB of entries. Their complete cache hashes matched.
Both kept the 256×2304 atlas, 38,338 native triangles, 8 excluded zero-area faces
and 1,024 rays per sample. Canonical furniture UVs change the exact sample layout:
301,505 active samples versus 301,424 previously. Thus the older and optimized
full-scene caches are not expected to match each other byte-for-byte.

After rotating the first sofa by 30 degrees, another full build completed in
27.67 s: 0.17 s atlas, 21.06 s transfer and 3.73 s CPU packing within transfer.
It reused all 20 allocations with zero packing calls, kept all 301,505 active
samples and generated a new scene/cache reference for the edited placement.
The 249.9 MiB transfer cache decoded and displayed four-bounce GI without browser
errors. The largest preparation-page frame gap was 80 ms.

Thirty-three focused tests, TypeScript and the production build passed. Tests
cover cache isolation and invalidation, rigid placement reuse, retained part
transforms and reflections, chart-retry UV equality, existing prepared caches,
and exact typed-packer equivalence with Map order and weights over changing rows.

## Transfer cache paging, 2026-09-18

The actual 19-piece IKEA fixture now completes and displays fresh four-bounce
GI. The renderer splits complete transfer rows into GPU pages of at most 128 MiB.
It processes all pages for each bounce before advancing. No connections are
dropped, ray counts remain 1,024, and existing cache files stay compatible.

One cold-worker run on the local Chromium desktop, active kernel, batch 1,024
and 8 ms pause:

| Measurement | Result |
| --- | ---: |
| Full preparation, validation and compression | 63.41 s |
| Loading / materials | 0.67 / 0.60 s |
| Atlas | 28.83 s |
| Transfer | 27.47 s |
| Validation / compression | 0.95 / 4.88 s |
| Lighting atlas | 256 × 2304 |
| Active samples / atlas slots | 301,424 / 589,824 |
| Packed transfer entries | 249.2 MiB |
| GPU cache pages | 2, each at most 128 MiB |
| Ray readback | 1177.4 MiB |
| Largest page frame gap during preparation | 80 ms |

The cache decoded and the preview completed all four bounces without browser
errors. Preparation timing excludes loading and applying the finished cache in
the preview. The entry size excludes other CPU/GPU buffers and textures.
This is a capacity fix, not a memory reduction or preparation speedup. The atlas
and transfer stages still dominate. Phone and whole-PC responsiveness remain
unmeasured; this one desktop run is not a general performance guarantee.

Eighteen focused tests, TypeScript and the production build passed. A separate
GPU test forced 18 small cache pages and verified byte-for-byte equal output
pixels against the single-buffer renderer in all six cases: two-light,
cross-page sample repair and rectangular seven-light filtered received diffuse,
each at day and night through four bounces. The previous full-IKEA failure below
records the condition this change removes.

## Real IKEA fixture check before cache paging, 2026-09-18

All nine new products passed file-hash and decoded triangle-count checks. Each
contains at most 3,000 triangles. The complete layout has 19 furniture instances,
36,178 furniture triangles, and 38,338 triangles including the apartment.
Fourteen focused tests, TypeScript and the production build passed.

The first full build exposed missing charts on small LISABO chair and VIHALS
cabinet faces. After the unwrap coordinate correction, all ten distinct products
(including the sofa) passed individual atlas generation. The full scene then
generated a 256×2304 atlas in 28.81 s, but transfer preparation hit the existing
128 MiB packed-entry limit after processing 144,384 active samples. It stopped
at 44.40 s total, with a largest page frame gap of 50 ms. No full cache was
produced or installed. This is a failed furnished-lighting test, not a successful
render or a performance claim. Low render-triangle counts alone do not bound
chart counts, lighting-sample counts, or cache memory. Memory reduction remains
necessary for this actual IKEA workload. The earlier simple-model results below
are historical baselines and must not be applied to this layout.

## Separate allocations and active kernel, 2026-09-18

Before the small-face coordinate correction, on the same local Chromium desktop,
three detailed sofas plus the apartment
used a 256×512 texture with 61,885 active samples out of 131,072 slots. Both full
builds used batches of 1,024 and an 8 ms pause. They produced byte-for-byte
identical caches, passed decoding, and displayed fresh four-bounce GI without
browser errors. These runs rebuilt allocation sizes without a previous layout.

| Kernel | Total | Atlas | Transfer | Ray readback | Largest page frame gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference | 62.25 s | 6.51 s | 54.53 s | 512.0 MiB | 633 ms |
| Active | 12.38 s | 6.45 s | 4.95 s | 241.7 MiB | 52 ms |

This is about 5× faster overall and 11× faster in transfer for this one local
comparison. It does not establish phone performance, whole-PC responsiveness,
or speed for Interior's larger sofa. A separate GPU check also verified exact
cache equality for two-light, sample-repaired and high-address seven-light cases.
Existing apartment and corrected APPLARYD caches still validate unchanged.

Before the IKEA replacement, the mixed 19-piece fixture completed with the active kernel: 13.55 s total,
2.37 s atlas and 8.95 s transfer, using a 256×640 texture and 104,147 active
samples. Its cache decoded and its four-bounce preview displayed without an
error. CPU tests ran concurrently, so treat this as a functional check rather
than a controlled speed comparison. It still uses 18 simple visible test models.

## Earlier combined-atlas baseline, 2026-09-18

After the zero-area fix, the 30-degree sofa completed a WebGPU short trial in
3.38 s. The three-detailed-sofa run reported the expected capacity failure in
3.57 s and remained in run history. The mixed 19-piece layout completed a full
cold-worker run in 26.73 s with batch size 1024 and an 8 ms pause: 1.12 s atlas,
24.67 s transfer, 32,120 active samples and five excluded zero-area faces.
Cache validation and the four-bounce preview succeeded with no browser errors.
Largest page frame gap was 433 ms. The layout contains 10,412 source triangles;
these timings do not establish performance for 19 detailed catalogue models.
Nineteen focused tests, TypeScript and the production build passed.

In the local Chromium in-app browser, with the original placement and 8 ms pause:

| Run | Batch | Total | Transfer | Largest page frame gap |
| --- | ---: | ---: | ---: | ---: |
| Warm short trial | 256 | 6.00 s | 5.23 s | 342 ms |
| Warm short trial | 1024 | 2.70 s | 1.86 s | 350 ms |
| Warm full build | 1024 | 24.69 s | 23.56 s | 417 ms |

The full build processed 33,728 active samples, passed cache validation, and
displayed fresh four-bounce GI without browser errors. It established a reference
hash; at that stage, cross-schedule full-cache equality had not been checked on the GPU.
Stop returned a cancelled result, and changing placement did not start a build.
These are single runs, not a stable benchmark or measurements of the editor's
larger asset. The larger batch improved this short trial's throughput but did
not improve its maximum page frame gap.

Run the focused checks with a current Node version:

```sh
node --experimental-strip-types --test tests/preparation-schedule.test.mjs tests/preparation-fixture.test.mjs tests/lighting-atlas.test.mjs tests/lighting-scene.test.mjs
npx tsc --noEmit
npx vite build
```

## Live preview prototype (18 September 2026)

The live path keeps rendering during preparation, transfers raw bytes, uploads
in 4 MiB writes and publishes only the completed four-bounce result. The same
19-piece IKEA fixture at the 30-degree sofa placement completed a cold worker
build in 46.38 s: loading 1.53 s, materials 0.64 s, atlas 12.92 s, transfer 30.35 s
and validation 0.94 s. It used 301,505 active samples in a 256 x 2304 atlas, with
249.9 MiB of entries in two pages. The largest preparation frame gap was 87 ms.

Visible GI arrived 58.81 s after the job started; installation after receipt took
11.24 s. The largest measured installation frame gap was 533 ms. An earlier
version that yielded during validation/uploads but computed surface geometry
synchronously stalled for 3,942 ms. Cooperative surface rasterization removed
that multi-second stall in this run, but synchronous chart/BVH work, fingerprints,
message delivery and allocations can still cause hitches. The visual transition
is complete GI replacing direct lighting, not progressive partial GI.

These are individual local desktop Chromium observations with the preview
rendering, not directly comparable performance claims against historical paused
runs. Preparation can take longer because the viewer shares the GPU and the
schedule yields more often. Whole-PC responsiveness and phone performance remain
unverified. Camera movement during installation was checked visually. An edit
during a running build cancelled the old job and only the new revision installed.

Verification: 106 local tests, TypeScript and the production build passed. GPU
checks compared synchronous/cooperative surface buffers and raw/chunked versus
gzip-loaded output. All six day/night output comparisons were pixel-identical.
Changing preparation batch sizes preserved cache bytes. The checks rejected
obsolete revisions, mismatched atlases, moved geometry with equal vertex counts,
and invalid fingerprints, and exercised cancellation during upload.

A repeated run reused all 20 atlas allocations (0 builds, 0 packing attempts).
Its atlas stage took 0.17 s, transfer 30.28 s, and worker total 32.09 s. The cache
hash matched the cold run exactly. Visible GI arrived at 43.32 s; installation
took 11.10 s, with a 458 ms largest installation frame gap. The largest frame
gap during preparation was 108 ms. This remains a responsiveness prototype with
measurable hitches, not a stable-frame-time or faster-total-bake claim.

## Provisional lighting stream (18 September 2026)

The lab now optionally sends visible lighting patches during ray preparation.
The preview includes measured skylight and one bounce from shadowed sun and
fixtures. Final filtered four-bounce GI replaces it without a blank transition.
See `docs/live-lighting-integration.md` for the APIs and acknowledgement protocol.

A final-version cold run of the same 19-piece IKEA fixture, with the sofa rotated
30 degrees, fixed 512-sample batches and an 8 ms pause, produced 71 patches.
The first arrived at 18.56 s, after atlas/source preparation. Worker preparation
finished in 49.04 s (atlas 12.78 s, transfer 33.34 s), and complete GI was visible
at 77.44 s. Installation took 27.17 s. The largest measured preparation and
installation frame gaps were both 1,009 ms. These background-browser observations
show streaming functionality; they do not establish stable frame times.

With streaming disabled, a repeated run reused all 20 atlas allocations, took
32.13 s overall (atlas 0.15 s, transfer 30.43 s), and matched the streamed run's
cache hash exactly. Its largest preparation frame gap was 1,058 ms. Cold/warm
loading and atlas work differ, so their total times are not a streaming-overhead
comparison. Streaming adds source-light computation, CPU accumulation, readback
and texture uploads. An adaptive repeated run also advanced much more slowly
and was stopped; its smaller batches/longer pauses make timing device-dependent.

Stop removed provisional GI and a subsequent run started successfully. Camera
movement was checked during streaming, and the scene retained that view after
final installation. The atlas remained 256 x 2304 with 301,505 active samples,
38,338 source triangles and 249.9 MiB of packed entries in two cache pages.

Verification: 106 local tests, TypeScript and the production build passed. GPU
checks exercised two- and seven-fixture streams, confirmed byte-identical final
caches, bounded/ordered early patches, receiving-sample validity and exact GPU
texture-region writes. They checked stale/duplicate/late updates, cancellation,
provisional-light retention during installation, lighting-state invalidation and
time changes during final installation. Existing six day/night raw-versus-gzip
and single-versus-paged output comparisons remained pixel-identical. Build
warnings about large chunks and xatlas's externalized Node module remain.
Phone performance, production Interior integration and reflection refreshes
remain unverified.

## Streaming finalization checks (18 September 2026)

Stream starts now carry the exact lighting state and fixture scale. The viewer
rejects delayed starts for different lighting and copies mutable host settings.
A rejected retry cannot attach later patches to an older provisional stream.
Idle visibility changes preserve the completed status. Downloaded reports now
retain first-patch time, patch count, complete-GI time and installation metrics.

The finalization run used the same 19-piece IKEA fixture, rotated 30 degrees,
with fixed 512-sample batches and an 8 ms pause. First lighting arrived at
19.02 s through 74 patches. Worker preparation took 49.62 s (atlas 13.06 s,
transfer 33.88 s); complete GI arrived at 73.24 s, including 22.10 s of final
installation. The largest preparation and installation frame gaps were both
1,009 ms. Camera movement during installation was retained. Switching tabs
after completion preserved the ready status. No browser errors were reported.
These are single desktop observations, not a stable-frame-time guarantee.

Verification: 107 local tests, TypeScript, the production build and GPU checks
passed. Added checks cover queued/running/cancelled/idle status, delayed lighting,
fixture-scale and sky mismatches, rejected retries and mutable lighting inputs.
Final cache bytes and all six final pixel comparisons remain unchanged. The
production editor, iframe relay, reflections and phone performance still need
integration verification.
