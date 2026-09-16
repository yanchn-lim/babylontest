# Remake comparison scene

[Open the published comparison](https://yanchn-lim.github.io/babylontest/comparison.html).

The latest user-approved visual checkpoint is commit `d2b7a18`, saved as tag
[`checkpoint/comparison-shadows-noise-2026-09-17`](https://github.com/yanchn-lim/babylontest/tree/checkpoint/comparison-shadows-noise-2026-09-17).
The earlier checkpoint `5a0ea1d` remains available as
[`checkpoint/comparison-2026-09-17`](https://github.com/yanchn-lim/babylontest/tree/checkpoint/comparison-2026-09-17).

The first remake study is at `comparison.html`. It provides one fixed test room,
a window, a doorway into a dark side room, simple material examples, and two
fixed interior lights. This is a reviewable lighting candidate, not an accepted
apartment renderer. The original apartment viewer is the other supported implementation.

## Controls and comparison

- Walk with W/A/S/D, arrow keys, or the touch pad. Drag the scene to look.
- Time of day ranges from 00:00 to 24:00.
- Auto turns the lights on before 07:00 and from 18:00. On and Off override it.
- Global illumination selects Radiance cascades or Baked baseline. WebGPU starts
  with cascades; WebGL uses the baked baseline and disables the cascade option.
- Diffuse bounces selects 1–4 indirect bounces for cascades. It defaults to the
  one-bounce checkpoint and is disabled for the baked baseline and WebGL.
- Six checkpoints cover morning, noon, afternoon, night with lights on, noon
  with lights on, and night with lights off.
- Two saved cameras provide 12 Cycles references. Compare side by side or with
  an opacity overlay. Walking hides the reference until the camera is reset.
- Intermediate times show the live result and explicitly report that an exact
  reference is unavailable. They do not show a nearby time as a match.

The sun path is a controlled experiment, not a Singapore solar-position model.
The window is an open aperture; glass is not part of this first scene.

## Radiance-cascade experiment

The first cascade implementation is a separate candidate in this same viewer.
It uses full-scene, world-space visibility, including geometry outside the camera
view. It is a small uniform-grid implementation of radiance intervals, not an
implementation of the Split Radiance Cascades paper's sparse hash structure.
There is no camera-dependent lighting history, temporal denoising or random
sampling between frames.

The implementation does the following:

1. Rasterizes the existing UVs into a 256 × 256 surface atlas. Geometry and
   material inputs come from the same exported scene as the Cycles references.
   Padding uses the closest triangle edge and extends smooth normals across
   UV seams. Ray origins remain on the mesh. Copying neighbouring texels had
   produced large discontinuities on the sphere's small UV islands.
2. Prepares static ray hits once on the GPU, in batches. Each surface uses 64
   fixed cosine-weighted gather directions, plus 1,024 sky directions prepared
   once to reduce sky banding. It caches sky and lamp visibility and the
   first 0.75 m of each gather ray. A triangle BVH (a spatial search tree) reuses
   the original viewer's geometry utility without changing that viewer.
3. Stores three world-space probe intervals: 0.75–2.25 m, 2.25–6.75 m and
   6.75–24 m. Probe spacing doubles from 0.5 m while direction counts increase
   from 32 to 128 to 512. These are distance ranges, not bounce counts.
4. When time or the lamp switch changes, computes directly lit surface radiance,
   including the visible sky. Sun visibility uses full-scene rays at the current
   sun direction; it is not interpolated between baked times.
5. Merges distant intervals into nearer intervals, then gathers bounced light
   at the surfaces. Cached direct sky visibility supplies the sky contribution
   separately, so coarse probe interpolation cannot leak direct sky light.
6. For each additional bounce, propagates only the previous bounce's radiance
   through the same intervals and gather. A separate buffer holds this increment
   and the running total. Direct sky is added once; direct sun and lamp light
   are not re-added on later bounces. Each input change starts a fresh series.
7. Adds the resulting linear diffuse radiance to Babylon's live direct sun and
   lamp shading. Surface colour is already included. Exposure is unchanged.

The result has **one to four indirect diffuse bounces**, plus direct sky illumination.
Cycles has up to eight bounces and includes glossy reflections. Coarse probes, angular
sampling, UV resolution and interpolation still produce bands and can leak
bounced light. The lamp depth bias removes the dotted ceiling self-shadows
in the tested views; shadow-map resolution still limits edge quality.
The shadow refinement uses 1,024-pixel lamp cube maps with Babylon's four-sample
Poisson filter, and medium-quality PCF for the sun with a matching depth bias.
Lamp map texel count is four times the earlier `5a0ea1d` checkpoint's; the
fixed lamp maps are still rendered only once.

Preparation and lighting updates run independently of camera motion. Lighting
updates use five dispatches per bounce, over 5/10/15/20 rendered frames for
1/2/3/4 bounces. Shader readiness can add frames. The previous finished texture
stays visible until the entire new series is written. During first preparation,
the baked baseline remains visible. The status identifies preparation, updating,
and the finished cascade result. A shader compilation failure keeps baked GI.
Continuous input queues the latest time, lamp state and bounce count while the current update finishes;
it does not restart the cascade merge on every input event.

For this scene, cascade buffers and the output texture allocate 82,796,496 bytes
(about 79 MiB), excluding Babylon's scene and shadow resources. The additional
2 MiB is fixed for all bounce settings. Static visibility
is prepared at load time; no new download or offline asset is needed. This first
implementation has not been measured on the target iPhone.

`window.comparison.state().cascades` exposes readiness, lighting revision,
requested/completed bounce counts, allocation size and optional GPU timings.
`lastUpdateDispatches` counts the completed series. `lastUpdateWallMilliseconds`
spans CPU scheduling from the first pass to submission of the final pass,
including frame spacing; it is not a GPU-only duration or a phone benchmark.
GPU timings describe the last dispatch
of each shader, **not** a full update or frame. In particular, `merge` reports the
last cascade level, and preparation timings report the last batch. Unsupported
GPU timers return `null`. Timing support is optional.

## Baked baseline

Use precomputed diffuse lighting on surfaces and live raster direct lighting.
Fixed geometry, fixed materials, fixed lamp positions and user permission for
offline preparation make this a useful first candidate. Camera motion only
changes the view; it does not restart any lighting calculation.

The runtime adds:

1. A full sky diffuse lightmap, scaled by the current sky intensity.
2. A blend of two neighbouring sun-indirect lightmaps, prepared at 06:00,
   09:00, 12:00, 15:00 and 18:00. Endpoint sunlight is zero.
3. A fixture-indirect lightmap when the lights are on.
4. Native Babylon direct sun and point lighting, with live shadow maps.

Sun shadows therefore move continuously. Bounced sunlight between checkpoints
is an interpolation approximation. Sky colour is fixed while intensity changes.
The lights share one switch. Surface colour is already included in each bake;
the runtime does not multiply the bake by albedo again. Linear RGBM maps use a
range of 16; generation rejects clipped output. No per-renderer exposure or
brightness adjustment is used to fit the images.

This baseline remains available to judge the new cascade experiment against
both the previous raster result and the offline reference.

The other straightforward option, blending fully baked daytime images on
surfaces, would also blend the direct sun shadows. Separating direct sunlight
lets the experiment retain moving shadows while evaluating the remaining
indirect-light approximation.

## Shared inputs and limits

Blender generates the actual triangle geometry, normals, UVs, material values,
camera parameters, and light values used by Babylon. Both outputs use the same
ACES fit, exact sRGB transfer, and fixed exposure. Cycles references use 1,024
samples, up to eight bounces, and offline denoising. Lightmaps use 4,096 fixed
samples, with adaptive sampling disabled, and OIDN RTLightmap filtering on
isolated UV islands. The higher-sample bake reduces the noisy source data
without adding a runtime blur. Raw bake arrays and EXRs
are retained under `.tools/comparison` for inspection. The baked mode has no
runtime ray tracing. The cascade mode traces visibility during preparation and
sun rays during lighting updates. Neither mode uses temporal accumulation or
runtime denoising.

The material models are not identical: Cycles uses Principled BSDF, while the
Babylon candidate uses PBR with Lambert diffuse. Local glossy reflections are
not implemented in Babylon. References include them. The 512-pixel atlas and
offline filtering leave visible texture and seam artifacts on some surfaces.
Point shadow maps can show self-shadow artifacts. These are open visual issues,
not accepted differences. The fixed exposure also leaves the daylight interior
quite dark; any later exposure change must remain identical in both renderers.

Visual inspection shows matching geometry and broadly similar light placement,
especially in the night view. The user-approved checkpoint is preserved above;
the shadow and noise refinements can be compared with it. Numerical parity and
phone performance are not established.

## Files and regeneration

- `scripts/prepare-comparison.py`: scene construction, bake and reference export.
- `scripts/comparison_denoise.py`: offline, isolated-island lightmap filtering.
- `public/comparison`: scene JSON, seven lighting maps, 12 references and provenance.
- `src/comparison/lighting.ts`: controlled time-of-day function and light switching.
- `src/comparison/lightmaps.ts`: linear baked-light composition in Babylon PBR.
- `src/comparison/radiance-cascades.ts`: surface preparation, buffers and update scheduling.
- `src/comparison/radiance-cascades.wgsl`: full-scene visibility, interval merge and surface gather.
- `src/comparison/main.ts`: scene construction, live lights, display and UI wiring.
- `src/comparison/navigation.ts`: keyboard and touch walking with collisions.

The preparation command uses the existing Blender 4.5.3 and OIDN 2.3.3 tools:

```powershell
& .\.tools\blender-4.5.3-windows-x64\blender.exe -b --python-exit-code 1 --python scripts/prepare-comparison.py
```

The helper runs in Blender's bundled Python as a separate process to avoid
conflicts between Blender's OIDN library and the RTLightmap library. Preparation
currently assumes the existing Windows tool layout. Runtime assets are portable.
`public/comparison/report.json` records samples, device, duration, data ranges,
asset sizes and hashes. Re-run generation after changing the scene or lighting
function; the matching function in `lighting.ts` must change with it.

## Minimal verification performed

- TypeScript check and production build passed using the existing Node 24 runtime.
  System Node is older than the package's required version and cannot build Vite 8.
- `scripts/check-comparison.cjs` checks lighting updates, saved views, navigation,
  cascade/baked switching, no GI recalculation while walking, WebGL fallback
  and narrow touch layout. These are focused browser checks, not a full suite.
- `scripts/check-comparison-bounces.cjs` checks all four counts at noon and night,
  nonnegative added radiance, exact restoration of one bounce, queued changes,
  and retention of the last finished result. One-bounce GI texture hashes match
  the published `d2b7a18` checkpoint at both times. Four-bounce walking reuses GI.
  One warmed desktop run scheduled the 1/2/3/4-bounce updates in approximately
  33/75/116/158 ms. These include frame spacing, not just GPU execution.
- Browser errors: zero. Daylight, night, doorway and overlay captures were
  visually inspected. Evidence is under `.tools/comparison`.
- The shadow/noise refinement also checks morning and afternoon sun shadows,
  night lamp shadows, and the baked WebGL fallback. The rebake preserves the
  scene and all 12 reference images byte for byte; all maps remain finite and
  within the RGBM range. Captures are in `.tools/comparison/refinement-final`.
- The initial capture used reversed back-face culling. The current import
  explicitly selects counter-clockwise winding. All 1,152 exported triangle
  normals agree with their winding. Comparing the current room with culling
  enabled and disabled changes only 13 of 335,336 pixels at edges, with no
  missing visible surface. Remaining patchiness is a lighting-map limitation.
- No full legacy test suite, performance benchmark, numerical convergence study,
  or physical iPhone test was run. They are not needed to review this first setup.

```powershell
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/typescript/bin/tsc --noEmit
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/vite/bin/vite.js build
# Defaults to the built preview at http://127.0.0.1:4185/comparison.html.
& .\.tools\node-v24.19.0-win-x64\node.exe scripts/check-comparison.cjs
& .\.tools\node-v24.19.0-win-x64\node.exe scripts/check-comparison-bounces.cjs
```

Next decision: review the cascade result against the baked baseline and Cycles
in both saved views at 1–4 bounces before expanding to the apartment. Phone
performance and asset-budget decisions follow acceptable small-scene visuals.

## Primary references

- [Blender Cycles baking](https://docs.blender.org/manual/en/5.0/render/cycles/baking.html): separate direct, indirect and colour passes.
- [Babylon PBR materials](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/materials/using/masterPBR.md): lightmap integration.
- [Open Image Denoise](https://www.openimagedenoise.org/documentation.html): offline RTLightmap filtering.
- [Radiance Cascades paper](https://github.com/Raikiri/RadianceCascadesPaper/blob/main/RadianceCascades.tex): distance intervals and spatial/angular resolution tradeoff.

Implementation also follows the pinned Babylon 9.25.0 source installed in this
project rather than assuming that current online APIs match the pinned version.
