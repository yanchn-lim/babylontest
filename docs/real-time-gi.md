# Optional real-time sunlight GI

Use **Settings > Lighting > Interior fill > Indirect lighting**.
Baked is the default. The selection saves with the other graphics settings.
Choose **Real-time GI (experimental)** to replace the indirect lightmap with
Babylon's reflective-shadow-map sunlight bounce.

## Integration

The installed Babylon.js 9.25.0 implementation was inspected directly.
Its FrameGraph scene path runs custom render targets, but does not run the
legacy geometry-buffer stage or the GI manager's before-draw callback.

`src/real-time-gi.ts` adds the manager's camera geometry buffer after the
reflective shadow map in the custom-target list. After those targets render,
it calls only the callback registered by that manager. Babylon supplies the
RSM capture, GI sampling, bilateral blur, upsampling, and PBR material plugin.
The existing FrameGraph then renders direct light, shadows, shafts, bloom,
tone mapping, and FXAA as before.

The RSM uses the existing sun object. The day/night module updates that
object before custom targets render. The adapter updates its light matrix
and captures its current direction, color, and intensity each active frame.
At zero sunlight, the GI material plugin is disabled so old bounce light
cannot remain visible.

Real-time mode removes `indirect.png` from the source PBR materials and sets
directional-lightmap strength to zero. Baked mode restores the same texture
and the user's directional setting. Baked brightness continues to track the
existing day/night state while its contribution is disabled.

The adapter allocates GI resources on first use. It releases manager render
targets when returning to baked mode, and retains the RSM for reuse. Resizing
recreates the camera-dependent targets. Disposal removes observers, targets,
the sample texture, cloned capture materials, and the RSM uniform buffer.
The latter cleanup uses Babylon's internal `engine._uniformBuffers` registry
because 9.25 does not release that buffer itself. Recheck this adapter when
upgrading Babylon. No dependency was added.

## Quality and limits

Defaults: 256 x 256 RSM, 64 samples, quarter-width/quarter-height GI,
half-float output, and Babylon's default bilateral blur/upsampling.
The capture materials follow the existing normal, roughness, and metallic controls.

This is an approximate single sunlight bounce. It does not calculate multiple
bounces, dynamic environment reflections, or secondary visibility between
bounce surfaces. Light leaks, noise, soft edges, and weak illumination in
enclosed rooms are possible. The fixed environment map and existing AO remain
active. First activation and mode changes can cause shader compilation pauses.

WebGL 2, at least three render targets, and the required floating-point texture
capabilities are checked before allocation. Unsupported hardware or detected
resource-creation failures return to baked lighting with an explanation.
Forced graphics-context loss was not tested.

## Verification on 2026-09-09

TypeScript, the production build, and all 40 Node tests passed.
The build retains the existing large-chunk warning.

The browser GPU check runs on the actual apartment and Sponza scenes:

- GI output is finite and nonzero.
- Moving sun azimuth from 35 to 215 degrees changes the normalized light
  distribution, not just its brightness.
- Half sun intensity gives a GI-energy ratio of approximately 0.500.
- Warm sunlight gives a blue-energy ratio of approximately 0.75.
- Zero sunlight disables stale GI. Baked textures return after each switch.
- Three mode cycles and two resize operations preserve resource counts.
- The restored baked framebuffer has zero mean pixel difference.
- GI-owned resources are released at scene disposal.

Run `./run.ps1 dev`, then open
`http://127.0.0.1:5173/?scene=bukit-merah&gi-test&gi-dispose` or
`http://127.0.0.1:5173/?scene=sponza&gi-test&gi-dispose`.
The disposal option stops the viewer after the check. Reload to resume.
These checks are excluded from the production build.

Production-preview visuals were checked in both scenes, both GI modes,
and with the Noon and Night presets. Night remains very dark because this
change adds no artificial lights.

### Performance

Existing stationary benchmark, default settings and starting cameras,
699 x 920 pixels, Windows/Chrome 152/WebGL 2. Each run used 15 seconds of
warm-up and 60 seconds of measurement. Values are milliseconds.

| Scene | Mode | GPU median | GPU p95 | Frame interval p95 |
| --- | --- | ---: | ---: | ---: |
| Apartment | Baked | 0.589 | 0.597 | 9.1 |
| Apartment | Real-time GI | 1.785 | 2.059 | 9.1 |
| Sponza | Baked | 0.901 | 0.915 | 9.1 |
| Sponza | Real-time GI | 5.651 | 6.225 | 9.4 |

All four runs measured about 120.5 fps median, with no frames over 33 ms.
The display limit hides the extra GPU cost. Direct-shadow binding remained
correct in benchmark diagnostics. These are single-run comparisons, not a
three-run or ten-minute soak test. Moving-camera performance, mobile hardware,
and larger resolutions were not benchmarked. Benchmark revision metadata
records base commit `f503235`; these measurements include the uncommitted GI work.

The disposal check also reports pre-existing scene/shadow renderer buffer
references outside GI ownership. It does not assert that all Babylon engine
bookkeeping is empty after scene disposal.
