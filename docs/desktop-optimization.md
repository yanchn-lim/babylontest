# Desktop renderer optimization

This pass remains under investigation. The 2x target has not been demonstrated.
Desktop results do not establish iPhone performance.

## Retained changes

- Render opaque depth before shading, using Babylon's material depth prepass.
  Exclude alpha-blended and alpha-tested materials.
- Store grayscale AO in R8 on WebGL 2. Babylon's existing grayscale AO shader
  already uses the red channel. This removes unused channels without changing
  the AO values. WebGL 1 retains RGBA.
- Use RGBA8 after tone mapping. Scene rendering and bloom remain HDR.
- Combine bloom addition with Babylon's image-processing pass. Keep Babylon's
  extraction, blur, and ACES processing. Skip the unused bloom merge and disabled
  bloom copy. Retain the blur texture as an explicit FrameGraph dependency.

The last change uses Babylon's scoped shader-processing hook and guarded pass
names for version 9.25.0. Its tests must pass before a Babylon upgrade.
The original geometry, ceiling, PBR materials, baked lighting, environment,
shadow settings, sun controls, and render scale remain available.

## Comparisons

Use the same graphics settings and camera for both URLs:

- Optimized: `?scene=bukit-merah`
- Original rendering path: `?scene=bukit-merah&renderer=baseline`

The baseline restores the rendering choices from 7052765: no added opaque
depth prepass, RGBA AO, separate bloom merge, and floating-point display target.
It shares the current controls and benchmark code.

Test hardware: AMD Radeon RX 5700 XT, driver 32.0.21043.19003,
Chrome 152, WebGL 2. Render dimensions: 2556 x 849, DPR 1.
PCF Low, 1024-square map, native scale, all effects enabled.
Sun: azimuth 35, elevation 58.6, intensity 3; environment 0.65;
exposure 2; shafts 0.1; bloom 0.12.

Each recorded run uses 15 seconds of warm-up and 60 seconds of measurement.
The desktop is capped at approximately 120 fps. Compare GPU query times,
not capped FPS. GPU elapsed queries are not a direct measure of GPU utilization.

| View | Baseline median GPU ms | Optimized median GPU ms | Ratio |
| --- | ---: | ---: | ---: |
| Living / dining | 1.8532 | 1.33196 | 1.39x |
| Hallway | 2.05546 | 1.23182 | 1.67x |

The optimized Living / dining repeats measured 1.33140 and 1.33228 ms.
The latter followed more than ten minutes of browser use and renderer checks.
These are fixed camera tests, not a walking-route comparison. In particular,
the Hallway preset faces a nearby wall; its result does not describe the full
apartment. More baseline repeats and matched walking tests remain necessary.

Run summaries are in [desktop-benchmarks.json](desktop-benchmarks.json).
Earlier development-server revision labels were stale; the run notes identify
the clean baseline and experiment variants. Uncommitted experiments also share
the baseline Git revision label, so use the variant and renderer profile.

## Rejected experiments

- UASTC lightmap compression: 1.33128 ms, effectively unchanged from PNG.
  The original 4096-square PNG remains unchanged.
- Cached sky: 1.29628 ms, but introduced a color mismatch and additional texture
  memory. The small gain did not justify retaining it.
- Separate depth task with simple materials: 1.33396 ms, no improvement over
  Babylon's simpler material depth prepass.
- Shafts-off diagnostic: 1.17368 ms. Shafts are restored in the retained renderer.

## Profiling and checks

Development builds accept `&gpu-task=scene` (or another FrameGraph task name).
This times that task instead of the whole frame, using Babylon timer queries.
The result's `gpuTiming.scope` identifies the scope. Never compare a task-only
number with a whole-frame number as a speedup. Unsupported GPU timing remains
explicit. The main scene task measured 0.744 ms in the Living / dining view.

The 29 automated tests and production build pass. Browser smoke checks exercised
PCF, PCSS, and hard-shadow modes with every bloom/FXAA/shaft on/off combination
in both scenes, with no reported console errors. The apartment also rendered
after sun changes, shadow-map changes, shadows off/on, viewport resizing, and
scene navigation. Phone-width portrait controls scroll and close correctly;
landscape controls and return to camera navigation were checked on desktop.

These checks do not establish pixel-identical output or iPhone performance.
Matched walking benchmarks, moving-sun timing, additional baseline repeats,
and device testing remain outstanding. An extra depth pass can behave
differently on a mobile GPU. Compare both URLs on the phone before drawing a
conclusion about its benefit.
