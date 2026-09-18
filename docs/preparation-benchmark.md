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

## Controlled comparison

1. Start with a **Short trial**. It stops after 4,096 work items: active samples
   for the active kernel, or atlas slots for the reference kernel. These workloads differ.
   A trial produces timings, not a usable lighting cache.
2. Repeat with the same placement and settings for a warm measurement.
3. Change the kernel, batch size or pause. The lab defaults to the active kernel,
   1,024 samples per batch and an 8 ms pause.
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

The preview pauses during preparation. The worker, GPU engine, model and bounded
atlas cache stay loaded between runs. Materials and transfer are rebuilt; exact
unchanged unwrap inputs reuse completed UVs. A completed
layout preserves instance slots. Allocation retries compute charts once and
repeat only packing. Sofa placement
changes clear the preview's old GI without starting preparation. Hiding the
page requests cancellation. Stop takes effect after the current GPU batch;
it cannot interrupt an already submitted dispatch or synchronous atlas work.

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

- Loading, Materials, Atlas, Transfer, Validation and Compression are wall times.
- Readback includes GPU execution, driver waits and copying. It is not a GPU
  timestamp query or a measurement of GPU utilization.
- Dispatch includes first-use compilation waits. CPU hit packing measures the
  JavaScript aggregation after each ray readback. Pauses report elapsed waits.
- Ray readback bytes exclude the final visibility readback and packed cache.
- Largest page frame gap uses `requestAnimationFrame` while the preview is
  paused. It does not measure other applications or prove the PC stays smooth.
- Short trials cover one atlas region. Do not extrapolate their speed to the
  full scene, or compare their totals with full builds.
- Total time ends in the worker before posting the result. Main-thread cloning,
  loading the result into the viewer, and final display are outside that time.
- The preview shows direct lighting until a full build succeeds. It omits
  reflection probes and bloom and is not a final visual reference.

The shared API accepts optional `transferOptions` with `batchSize` (multiples
of 64 from 64 to 4096), `pauseMilliseconds` (0 to 100), `strategy` (`active` or
`reference`), and `onBatch(timings)`. Shared API defaults are 1024/8 with the active
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
