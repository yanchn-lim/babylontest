# TAA experiment

Branch: experiment/gi-taa. Production main is unchanged.

Enable Settings > Quality > Experimental TAA, or add taa=1 to the URL.
The toggle reloads the scene. Without the parameter, the existing FXAA path remains.
Select Real-time GI separately under Lighting.

Babylon 9.25 FrameGraphTAATask uses eight samples, a current-frame weight of
0.15, velocity reprojection, and history clamping. The main geometry renderer
writes color and linear velocity in one pass. TAA runs after tone mapping.

The small ThinTAAPostProcess subclass exposes the native jitter offset.
The GI geometry buffer applies the same offset through its scene projection.
The camera projection is not mutated. RSM material clones are excluded from
camera jitter. A WeakSet prevents duplicate callbacks on reused GI targets.

Control changes, GI mode changes, sun changes, and graph rebuilds reset history.
Reset uses Babylon 9.25's internal _reset method; check this on engine upgrades.
FrameGraph owns the TAA history textures. Scene disposal removes control hooks.
Unsupported devices retain the FXAA path and receive an explanation.

## Verification — 2026-09-09

- 41 Node tests pass, including history reset and control-listener cleanup.
- TypeScript and production build pass.
- Browser GI regression checks pass with TAA in apartment and Sponza:
  sunlight distribution, intensity, color, night, baked restoration, mode
  changes, and resizing. GI resource counts remain stable.
- Day/night and baked/real-time views inspected in both scenes.
- No shader errors reported during these checks.

Apartment static benchmarks: 1280x720, identical camera and settings,
real-time GI, 512 RSM, 128 GI samples, half-resolution GI, 1024 low PCF shadows.
Each run used 15 seconds warm-up and 60 seconds measurement on local WebGL 2.

| Path | GPU median | GPU p95 | Frame p95 | Median FPS |
| --- | --- | --- | --- | --- |
| FXAA | 4.52728 ms | 5.78906 ms | 9.4 ms | 120.48 |
| TAA | 4.57968 ms | 4.90796 ms | 9.3 ms | 120.48 |

Runs started at 08:23:57 UTC (FXAA) and 08:20:15 UTC (TAA).
They used the working tree based on 70f064b. The TAA run preceded the
callback deduplication and explicit GI mode reset corrections.

One run per path is insufficient to establish a general performance result.
No matched Sponza or long-duration motion benchmark was performed.
No quantitative shimmer-reduction measurement was performed.

A final apartment run at 1280x720 failed the baked-image comparison
(mean byte error 34.56). An immediate rerun passed (0.030), including GI
resource disposal. The cause of this intermittent mismatch is not isolated.
Do not treat restoration verification as consistently passing.

This is full-scene TAA, not a GI-specific temporal denoiser. Softening,
residual shimmer, and ghosting remain possible. Frequent sun updates reset
history and limit accumulation during the day/night cycle. RSM light leaks
and coarse lighting changes are not fixed by this experiment.

## Preview deployment

The separate yanchn-lim/babylontest-taa-preview repository deploys this branch.
After pushing the branch, run:

gh workflow run preview.yml --repo yanchn-lim/babylontest-taa-preview

Do not use the production Pages workflow for this experiment.
