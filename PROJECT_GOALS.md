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
