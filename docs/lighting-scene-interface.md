# Shared lighting scene preparation

`src/apartment/prepare-lighting-scene.ts` exports `prepareLightingScene` for
editors that use the cached dense diffuse renderer. It owns atlas generation,
scene extraction and transfer preparation. Editors must not repack the returned
atlas or combine its cache with a different model revision.

```ts
import { LightingAtlasCache, prepareLightingScene } from './src/apartment/prepare-lighting-scene';

// Create once in the preparation worker, outside the per-build handler.
const atlasCache = new LightingAtlasCache();

const prepared = await prepareLightingScene({
  meshes,                         // Concrete Babylon Mesh objects in model load order
  furnitureMeshes: new Set(furnitureMeshes),
  furnitureGroups: new Map(instances.map(instance => [
    instance.id, new Set(instance.meshes), // Stable placed-instance ID, not catalogue ID
  ])),
  previousLayout: lastPrepared?.sceneData.lightingLayout,
  atlasCache,                      // Optional: reuse completed unwraps between builds
  settings: { fixtures, sky, views },
  engine,                         // Initialized WebGPUEngine
  signal: controller.signal,
  onProgress(stage, fraction) {
    reportProgress(stage, fraction);
  },
});

// These three outputs belong to the same scene revision.
const atlasJson = JSON.stringify(prepared.atlas);
const sceneJson = JSON.stringify(prepared.sceneData);
const transferBytes = prepared.transferBytes; // Raw bytes; gzip for transfer.bin.gz
```

## Inputs and ownership

- Supply static meshes with triangle indices, vertex normals and PBR materials.
  Animated meshes and thin instances must first be expanded into static meshes.
- Supply every furniture mesh explicitly. Remaining opaque meshes are architecture.
  Do not rely on a particular editor's metadata property names.
- Group all meshes of each placed furniture instance under a stable, unique ID.
  Groups must cover `furnitureMeshes` exactly once. If groups are omitted, each
  furniture mesh receives its own allocation, identified by its mesh-list index.
  This fallback works, but explicit instance IDs preserve slots when mesh order changes.
- Supply geometry in metres with the same world transforms used by the viewer.
  Mesh order must match the model loader. The result's UV arrays follow triangle
  index order, matching `convertToUnIndexedMesh()` in the apartment viewer.
- Keep the preparation scene stable during the call. Use a worker or an isolated
  scene, as the current editor does. A live scene can change while textures load.
- Supply one to eight fixed lights, each with a finite position, colour and
  nonnegative intensity. The existing apartment viewer additionally requires its
  own seven-fixture preset; this API does not change the viewer's room/light UI.
- For imported glTF preparation meshes, use `useSRGBBuffers: false`, matching the
  existing CPU texture-readback path. Original render materials keep their native
  textures and coordinates.
- The function does not change input geometry, native UVs or `uv3`, dispose caller
  resources, export a GLB, or install results in a running viewer.

## Atlas rules

Architecture uses connected coplanar charts. Shared edges include T-junctions.
As in `scripts/prepare-apartment-atlas.py`, the receiving side of a shared edge
is checked 8 mm above the surface; an opaque nonparallel wall blocks a join.
Each resulting region is a separate rectangular packing proxy. Packing cannot
join these regions again merely because they lie on the same plane.

Furniture receives an xatlas unwrap from its geometry. Shared rigid placement
ancestors are removed from the unwrap input so repeated copies and moved or
rotated instances can reuse the same UVs. Scale, reflections, pivots and internal
part transforms are retained. Frozen or unsupported transform hierarchies fall
back to world-space inputs and may get fewer cache hits. Native material UVs are
not assumed to be a unique lightmap unwrap. For the unwrap only,
each furniture group is translated near the origin and expressed in millimetres.
This avoids xatlas's absolute tolerances dropping valid sub-millimetre IKEA faces.
Native and ray-tracing geometry remain in metres. Zero-area classification still
uses the original metre-based tolerance before this conversion. Architecture has
its own 256×256 region. Each furniture instance gets a separate 64, 128 or 256px
square, with two-pixel padding and bilinear-filter support. These regions occupy
one rectangular texture, 256px wide and at most 8192px high. This is separate
allocation, not a separate render model or texture per object.

`sceneData.lightingLayout` records dimensions and instance allocations. Return
the last completed layout as `previousLayout` to keep slots for existing IDs.
Removed slots can be reused. A slot can move if that item's new unwrap requires
a larger allocation. Adding furniture does not repack architecture. Each call
still rebuilds lighting transport for the whole scene, including light exchanged
between apartment and furniture. Stable slots do not make old visibility reusable.

`atlasCache` is optional. Without it, duplicate unwraps are reused within one
call. Retain a `LightingAtlasCache` in the worker to reuse architecture and
furniture unwraps across calls. It hashes exact unwrap geometry, normals, mesh
order and requested size; changed inputs regenerate their atlas. It stores only
completed results, returns copies, and retains at most 64 keys in memory. It is
not persistent storage. Call `clear()` to release its entries. `previousLayout`
still controls allocation positions separately; it alone does not cache UVs.
Allocation-size retries compute charts once and repeat only packing. Atlas stats
report `atlasBuilds`, `atlasCacheHits` and `packingAttempts` for actual work.

Canonical furniture inputs can change newly generated UVs compared with older
world-space unwrapping. Regenerate atlas, scene data and transfer together.
Existing prepared viewer assets are unchanged. Reusing an unwrap never reuses
scene visibility or transfer after furniture movement.

Returned UVs use pixel coordinates divided by **256 in both axes**. Furniture
V coordinates can exceed 1. Do not clamp, normalize, repack or quantize them to
the 0–1 range. `CachedTransfer` creates the rectangular texture, and
`ApartmentLightmap` applies its height scale when sampling. The renderer uses
cache version 2 with 21-bit target addresses and exact 1,024-ray hit weights.
Existing scenes without `lightingLayout` retain the version 1 format.

One item can still exceed its 256px allocation. Architecture can still exceed
its reserved region. These failures remain explicit; padding is not removed.
Packed transfer entries are split automatically into GPU buffers of at most
128 MiB each. A complete lighting-sample row stays in one buffer. Every page
finishes a bounce before the next bounce starts; no connections or ray weights
are discarded. The cache file format and preparation API stay unchanged.
The display renderer must include this paging support to load larger caches.
Paging removes the single-buffer capacity limit, but keeps all pages in GPU
memory. It does not reduce total cache memory, atlas work or ray tracing.
The device texture limit and available CPU/GPU memory still apply. These bounds
do not guarantee that arbitrary catalogue assets fit.
No furniture simplification or lighting-proxy generation is included.

Validation checks array sizes, finite coordinates, collapsed mapped triangles
and collisions between chart interiors at the renderer's resolution. It is not
a proof of watertight geometry or leak-free GI. Like the existing Blender rule,
wall separation follows existing triangle edges; this API does not cut triangles
where a wall crosses their interior. Transparent materials remain excluded from
opaque diffuse transport. The separate APPLARYD comparison sample-repair profile
is not automatically applied to arbitrary furniture.

Zero-area faces use the same tolerance as architectural charts (cross-product
magnitude at most `1e-10` in metre-based geometry). They do not enter furniture
unwrapping. Their returned UV slots remain zero, in the original triangle-corner
order. `sceneData.meshes[].indices` excludes those faces from ray tracing and
surface sampling, while its vertex arrays and the native render model retain
their original order. `stats.atlas.ignoredTriangles` reports excluded opaque
faces. Valid 3D triangles still require valid, non-collapsed lighting UVs.

This changes the prepared scene fingerprint when faces are excluded. Regenerate
atlas, scene data and transfer together. Existing prepared viewer assets are not
rewritten, and the legacy `prepareScene` path retains its existing behavior.

## Editor integration

In Interior's `walkthrough/prepare-edited-model.js`, replace the custom
`editedAtlas(...)` and separate `prepareScene(...)` / `prepareTransfer(...)` calls
with the shared call above. Pass the actual imported Babylon meshes, not the
editor's geometry wrappers. Build `furnitureMeshes` from the existing furniture
ownership metadata while constructing the input.
For the separate allocations, also build `furnitureGroups` from placed-instance
ownership, and retain the last successfully installed `sceneData.lightingLayout`.
Do not use a product ID for multiple placed copies of the same sofa.

Keep the existing GLB exporter and `packLighting` resource names:

| Embedded resource | Shared result |
| --- | --- |
| `apartment-transfer/atlas.json` | JSON of `prepared.atlas` |
| `apartment-transfer/scene.json` | JSON of `prepared.sceneData` |
| `apartment-transfer/transfer.bin.gz` | Gzip of `prepared.transferBytes` |
| `models/bukit-merah/pbr/indirect.png` | Existing fallback image; no baked fallback is generated by this API |

Continue installing only the latest completed editor revision. Pass an abort
signal for obsolete work. The API checks cancellation between CPU/GPU stages and
GPU batches; synchronous WASM work cannot receive a new event until it yields.
Terminating the preparation worker remains the immediate cancellation path.

Build preparation and display from the same renderer revision. Updating only
the editor's import while leaving the viewer on its old pinned shader revision
can fail cache fingerprint validation. Publishing this interface does not update the
Interior submodule pin or deploy the published site.

## Verification

For preparation profiling, `/preparation.html` uses the same API with optional
`transferOptions: { strategy, batchSize, pauseMilliseconds, onBatch }`. The shared
API defaults to `strategy: 'active'`, 1,024 samples per batch and an 8 ms pause.
Only occupied samples are traced and read back. Each sample's 1,024 rays are
shared across 64 GPU lanes while preserving original ray order and exact weights.
CPU hit packing uses reusable typed counters and retains first-hit entry order,
matching the previous Map-based cache packing exactly for the same ray results.
`strategy: 'reference'` retains the full-atlas preparation kernel for validation.
Direct `prepareTransfer` callers retain their 256/0 batch and pause defaults;
their default kernel is also active. `onBatch` reports processed work items,
total work items, atlas pixels, active samples and ray-readback bytes.
See [the preparation lab](preparation-benchmark.md)
for bounds, timing definitions and controlled comparisons.

- `node --experimental-strip-types --test tests/lighting-atlas.test.mjs tests/lighting-pages.test.mjs tests/lighting-scene.test.mjs`
  checks wall separation, T-junctions, padding after packing, actual apartment
  plus 7,628-triangle APPLARYD packing, input preservation, transforms and cancellation.
  The API unit test replaces GPU execution only.
- Start Vite, open `/tests/lighting-scene.browser.html`, and select **Run WebGPU
  preparation**. This loads the real apartment and original sofa GLB, prepares
  the full cache, validates it with `decodeTransfer`, checks unchanged source
  geometry/UVs, and confirms that changed geometry invalidates the cache.
- `/tests/active-transfer.browser.html` compares complete reference/active cache
  bytes for two-light, sample-repaired and seven-light paged scenes. It checks
  traced targets above 65,535 and reduced readback.
- `tests/transfer-pages.test.mjs` checks whole-row boundaries, empty rows and
  exact large entry addresses. `/tests/transfer-pages.browser.html` forces small
  cache pages and compares every output pixel with a single buffer through four
  bounces and day/night updates, including repaired rows and rectangular atlases.
- Run TypeScript and the production build. Existing fixed viewers and prepared
  assets do not need to be regenerated to add this interface.

## Live display without a completed cache

For geometry-first viewing and revision-safe lighting installation, see
[live lighting integration](live-lighting-integration.md). Preparation still
returns a complete matching result. The new viewer can show direct lighting
while that result is built, then install raw transfer bytes without a reload.
