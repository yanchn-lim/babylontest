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

## Whole-scene ray refinement (local experiment)

Enable **Stream provisional lighting** and **Refine whole scene**, then use
**Build full lighting** with the active-sample kernel. The atlas stays fixed.
Each active sample receives 64 rays, then another 192, then another 768. Patches
continue during each pass. The progress bar measures ray work: whole-scene
64-ray coverage is 6.25%, and 256-ray coverage is 25%. Short trials do not run
refinement. Uncheck **Refine whole scene** to compare the prior regional stream.

Intermediate passes use the existing measured-sky/one-bounce preview. The full
four-bounce cache installs once. Compact partial hit counts retain each target's
earliest original ray; fixed ray slots restore final entry order without sorting
every row. This uses additional CPU memory and merging work. It is intended to
improve early whole-scene feedback, not reduce the final ray count or guarantee
a faster complete bake.

Verification: 110 local tests, TypeScript and the production build passed.
After replacing per-row sorting, the three new unit tests and GPU checks passed
again. GPU checks cover all three whole-scene passes, changing batch boundaries,
cancellation, unchanged ray readback, byte-identical final caches and identical
final provisional pixels for two- and seven-light scenes. Existing six day/night
final-output comparisons remain pixel-identical. Phone performance and peak
memory are unmeasured. Existing build warnings remain.

Final-version observations used the 19-piece IKEA scene, rotated 30 degrees,
fixed 512-sample ray budgets and an 8 ms pause, with adaptive pacing disabled:

| Measurement | Cold worker | Warm worker |
| --- | ---: | ---: |
| First streamed patch, from run start | 17.11 s | 2.80 s |
| 64-ray coverage, from transfer start | 6.15 s | 5.60 s |
| 256-ray coverage, from transfer start | 13.06 s | 12.45 s |
| 1,024-ray coverage, from transfer start | 38.15 s | 38.67 s |
| Atlas generation | 11.68 s | 0.16 s |
| Worker total | 53.03 s | 40.78 s |
| Complete four-bounce GI, from run start | 64.39 s | 50.77 s |
| CPU hit packing | 8.87 s | 9.04 s |
| Largest preparation frame gap | 125 ms | 117 ms |
| Largest installation frame gap | 383 ms | 367 ms |

The warm run reused all 20 atlas allocations. Its whole-scene 64-ray pass
completed roughly 6.4 s after the run started, including material/atlas work.
Both final caches matched the prior regional-stream baseline hash exactly for
the same scene. Ray readback remained 1,177.8 MiB, with 301,505 active samples
in a 256 x 2304 atlas and two final transfer pages. Cold/warm runs emitted 145
and 146 patches. Navigation and final handover remained usable; no browser
errors were reported. These are individual desktop observations, not a total
speedup claim or a phone responsiveness guarantee.


## Early four-bounce checkpoints (local experiment)

Whole-scene refinement now prepares viewer resources as soon as the atlas is
ready. Completed 64-ray and 256-ray transport checkpoints use the same four
bounces, bounced sky and filter as final lighting. The viewer retains the previous
image during each upload and calculation. It ignores subsequent one-bounce
patches. The worker waits for each checkpoint to be published before continuing.
Geometry, static GPU buffers and shaders are reused for the final cache.

The same 19-piece IKEA fixture, rotated 30 degrees, used fixed 512-sample ray
budgets, 8 ms pauses and no adaptive pacing. Times are individual desktop runs:

| Measurement | Cold worker | Warm worker |
| --- | ---: | ---: |
| First provisional patch, from run start | 17.41 s | 3.13 s |
| 64-ray four-bounce GI visible, from run start | 24.86 s | 10.77 s |
| 256-ray four-bounce GI visible, from run start | 36.16 s | 21.41 s |
| Final 1,024-ray GI, from run start | 66.99 s | 52.46 s |
| Worker total, including checkpoint waits | 61.42 s | 47.98 s |
| Final installation | 4.43 s | 4.36 s |
| Largest preparation frame gap | 392 ms | 417 ms |
| Largest final installation frame gap | 275 ms | 283 ms |

Compared with the preceding progressive-only run, warm final installation fell
from 9.89 s to 4.36 s, while total time increased from 50.77 s to 52.46 s. Cold
total increased from 64.39 s to 66.99 s. Checkpoints add copying, validation,
uploads and lighting calculations. Their benefit is earlier full-model lighting
and a smaller final installation, not a lower total ray count or total-time
speedup. Preparation frame gaps increased as installation work moved earlier.
The change does not remove every visible quality transition or main-thread hitch.

Both final caches exactly matched the prior progressive and regional-stream
baseline (input hash `60ee2d18d2cc90797735aff75345d8c9e1d0a9da23e5f95407630e4d3cbbd690`,
output hash `e532f62b840abdb47d03d4e40b91ecfd43a885d2c13c3bba53d923f4639f9576`).
The warm run reused all 20 atlas allocations. Final entries remain 249.9 MiB
across two pages; the atlas remains 256 x 2304. No browser errors were reported.

Verification: 112 local tests, TypeScript and the production build passed.
The existing large-chunk and xatlas Node-module build warnings remain.
GPU checks compare 64-ray
and 256-ray output with independently normalized fixed-denominator reference
caches at day and night, with and without filtering. Final pixels remain exact.
They verify static GPU buffer reuse, publication only after four bounces,
retention during updates, rejection of later provisional patches, one final
ready callback, stale revisions, cancellation and premature-final error reporting.
The existing six raw/gzip and paged/single-buffer comparisons also remain exact.
Phone performance, peak memory and production Interior integration remain unverified.


## Refinement overhead reduction (local experiment)

The first full-lighting checkpoint now ends provisional preview generation.
Later passes alternate two ray-result buffers, submitting at most one batch
ahead of CPU packing. Configured pauses remain. Checkpoint and final validation
retain hit totals for receiving-sample rejection, avoiding a second connection
scan. Validation and atlas installation yield according to a 4 ms CPU work
budget checked between small blocks. GPU uploads still yield between bounded
writes. Checkpoint installation remains sequential with the next ray pass.

Measured with the same 19-piece IKEA fixture, 30-degree sofa rotation, fixed
512-sample budgets and 8 ms pauses, with adaptive pacing disabled. Times below
are from run start except the installation duration:

| Measurement | Previous cold | New cold | Previous warm | New warm |
| --- | ---: | ---: | ---: | ---: |
| First provisional patch | 17.41 s | 18.83 s | 3.13 s | 3.62 s |
| 64-ray four-bounce GI visible | 24.86 s | 23.47 s | 10.77 s | 8.49 s |
| 256-ray four-bounce GI visible | 36.16 s | 28.38 s | 21.41 s | 13.42 s |
| Final 1,024-ray GI | 66.99 s | 48.61 s | 52.46 s | 34.76 s |
| Final installation duration | 4.43 s | 1.61 s | 4.36 s | 1.83 s |
| Largest preparation frame gap | 392 ms | 400 ms | 417 ms | 400 ms |
| Largest installation frame gap | 275 ms | 342 ms | 283 ms | 408 ms |

Warm completion time fell by 33.7%; cold completion time fell by 27.4%. These
are individual desktop runs, not device-wide guarantees. Initial patches did
not arrive earlier, and frame hitches remain. The warm gap between the 64-ray
and 256-ray images fell from 10.64 s to 4.93 s.

Each run overlapped 583 of 659 batches. Provisional lighting was calculated for
301,505 samples, only the first pass. Raw ray readback stayed at 1,177.8 MiB.
The warm run reused all 20 atlas allocations and spent 0.24 s on the atlas.
CPU packing took 7.39 s; the 11.13 s readback counter now measures the remaining
awaited time after overlapping CPU work, not total GPU execution time. Intentional
pauses remained 5.83 s. The extra GPU ray-result buffer is 2 MiB at these settings;
readback storage also increases while one batch is in flight. Peak memory was
not measured. Final transport remains 249.9 MiB over two GPU pages.

Both completed cache hashes match the prior checkpoint, progressive and regional
baselines exactly for the same input. Browser logs contained no errors or warnings.
Verification passed: 113 local tests, TypeScript, the production build and GPU
checks. Added coverage verifies timed CPU yields, retained validation hit counts,
unchanged final bytes under changing batch sizes, no discarded preview generation,
no repeated rays and cancellation with an overlapped batch in flight. Existing
checkpoint day/night, filtering, final-pixel, lifecycle and legacy-cache checks
remain exact. The existing large-chunk and xatlas Node-module build warnings
remain. Phone performance and production Interior integration remain unverified.


## Five refinement stages (local experiment)

At the user's request the sequence is now 64, 128, 256, 512 and 1,024 total rays.
Each pass reuses earlier results and adds 64, 64, 128, 256 and 512 new rays.
The four intermediate checkpoints all use four bounces and final filtering.
Only the first pass generates provisional patches. Later passes retain bounded
GPU/CPU overlap and each checkpoint still waits for viewer acknowledgement.

Measured with the same 19-piece IKEA fixture, 30-degree sofa rotation, fixed
512-sample ray budgets and 8 ms pauses, with adaptive pacing disabled:

| Visible lighting, from run start | Cold worker | Warm worker |
| --- | ---: | ---: |
| 64 rays | 23.22 s | 8.27 s |
| 128 rays | 25.96 s | 10.78 s |
| 256 rays | 29.35 s | 14.17 s |
| 512 rays | 35.38 s | 20.96 s |
| Final 1,024 rays | 48.25 s | 34.69 s |

The previous three-pass totals were 48.61 s cold and 34.76 s warm, so total time
was similar in these individual runs. The warm 256-ray checkpoint arrived
slightly later (14.17 s versus 13.42 s), with a new 128-ray update in between.
These observations do not establish that additional checkpoints are free: they
add packing, transport upload and lighting work, while changing batch sizes and
CPU/GPU overlap. Peak memory and phone behavior remain unmeasured.

Both final cache hashes exactly match the preceding three-pass runs. Raw ray
readback remains 1,177.8 MiB, so no rays were repeated. The warm run reused all
20 atlas allocations. Preparation frame gaps reached 417 ms cold and 433 ms
warm; installation gaps reached 292 ms and 383 ms. No browser errors or warnings
were recorded. Final transport still occupies two pages with 249.9 MiB entries.

Verification: six targeted tests, TypeScript, the production build and GPU
checks passed. Checks cover all five pass prefixes, exact packing for both
address widths, all four checkpoint ray counts, whole-scene coverage, unchanged
final cache bytes, checkpoint day/night pixels and final pixels, cancellation,
changing batch sizes and the existing live-viewer lifecycle. Existing build
warnings remain. Production Interior integration remains unverified.


## Wall-intersection leak regression

The lab now calls `partitionLightingArchitecture` once on its architecture in
both the viewer and worker. It preserves visible shape and native material UVs,
but adds edges where opaque surfaces intersect triangle interiors. The living
room's right wall extends behind its window wall. Before subdivision, adjacent
samples on that single wall chart lay on opposite sides of the window wall;
the outdoor sample saw approximately 43% sky while the indoor sample saw none.
Bilinear filtering blended exterior light into a bright indoor corner seam.
Separate padded charts now keep all four interpolation samples inside the room.

The same 19-piece IKEA fixture with a 30-degree sofa rotation, 512-sample batches
and 8 ms pauses completed the repaired warm build in 36.05 s. It reused all 20
atlas allocations (0.22 s atlas work), showed its first provisional patch at
4.24 s, and displayed four-bounce checkpoints at 8.22, 10.73, 14.73 and 21.45 s.
The final cache exactly matched the repaired cold build. The full atlas remained
256x2304; the architecture region remained 256x256. Total triangles rose from
38,338 to 49,090; furniture retained its original 36,178 triangles. Final entries
were 158.9 MiB across two pages. The largest warm preparation frame gap was
550 ms; the largest final-installation gap was 441 ms. Phone performance is untested.

The cold run took 68.08 s, including 23.71 s atlas work. A CPU regression test
ran concurrently during part of that run, so this is not an isolated performance
comparison. Subdivision adds cold preparation work and increases atlas chart
count. It changes lighting sample locations and overall indirect brightness;
it is not a pixel-identical correction outside the observed seam. The fixed
architecture resolution can lose spatial detail as more charts share it.

The completed GPU view was checked with all lights and indirect light alone;
the bright vertical seam was absent. The geometry regression checks material UV
interpolation and that glass and excluded furniture remain unchanged. The actual
apartment regression checks the four bilinear sample positions at several heights
along the corner. This does not establish leak-free lighting for every scene.
See [the integration requirement](lighting-scene-interface.md#wall-intersections).

Verification: 115 local tests, TypeScript and the production build passed.
The existing xatlas browser-module and large-bundle warnings remain.
