# Babylon.js apartment lighting lab

An interactive TypeScript and Vite viewer for the Bukit Merah Ridge apartment and
Sponza. Built with standard Babylon.js 9.25.0 and a custom FrameGraph renderer.

[Open the apartment](https://yanchn-lim.github.io/babylontest/?scene=bukit-merah)

The viewer includes PBR materials, movable sunlight, shadows, bloom, light shafts,
and an artistic day/night cycle. The apartment supports baked lighting and
experimental WebGPU probe global illumination (GI). WebGPU is preferred when
initialization succeeds; WebGL provides the baked-lighting fallback. No SSGI is used.

## Run locally

From the repository root in PowerShell:

```powershell
.\run.ps1 setup
.\run.ps1 dev
```

The launcher downloads a SHA-256-checked Node.js 24.19.0 runtime into the ignored
`.tools` directory without replacing your system Node installation. Setup installs
pinned dependencies and downloads the Sponza assets and environment lighting.
Open the address printed by Vite. Stop the server with Ctrl+C.

With your own Node installation, use Node 24 to match CI:

```powershell
npm ci
npm run assets
npm run dev
```

Open `/?scene=bukit-merah` for the apartment. The apartment assets are committed
under `public/models/bukit-merah`; `npm run assets` does not generate them.

## Environment controls

Select **Controls** to open the inspector. It starts closed, opens on the right on
desktop, and uses a bottom sheet on portrait phones. **Expand** provides more space;
**Close** or Escape returns to the scene. The canvas stays full-size.

| Category | Controls |
| --- | --- |
| Environment | Time of day, presets, playback, sun brightness and warmth, manual direction, GI mode and strength |
| Lights | Session-only lamps and downlights, on/off, brightness, temperature, position, rotation, beam angle, removal |
| Materials | Material selection, wall color, roughness, texture detail, reflections, metallic level, material reset |
| Image | Exposure, contrast, bloom, light shafts |
| Quality | Render scale, anti-aliasing, shadow resolution, method, filtering, softness, bias |
| Camera | Walk/Fly, mouse capture, navigation help, session reset, panel appearance, attribution |

Advanced tuning is collapsed initially. Panel opacity is adjustable from 70–100%
under **Camera → UI appearance**, with an 88% default and solid control fields.
Category, expansion, and opacity preferences are stored separately from graphics
settings. These UI changes do not invalidate a benchmark or rebuild the render graph.

Graphics settings persist across scenes. Material adjustments are saved per scene
and affect every surface using the selected material. Fixtures are session-only.
Use the material reset for one material, or **Camera → Session** for the global reset.

## Navigation

- Click or drag the scene to look. Use WASD or arrow keys to move; Shift moves faster.
- Apartment **Walk** mode keeps a 1.65 m eye height and uses wall and door collisions.
  It assumes a level floor and does not simulate stairs or gravity.
- **Fly** follows the camera direction without collisions. E rises and Q descends.
- On touch screens, use the movement stick and drag the scene to look. Fly mode
  also provides Up and Down controls.
- **Capture mouse** enables continuous mouse look; Escape releases it.

Opening the inspector clears held movement. Editing controls does not move the
camera, and closing the inspector does not resume stale input. Movement also stops
on focus loss or when the page is hidden.

## Lighting modes

**Baked** is the default. It combines fixed diffuse skylight and ambient occlusion
with real-time direct sunlight and shadows. The apartment also supports directional
baked response for material normals. Moving the sun does not rebake these textures.

**Real-time probe GI** requires WebGPU. It prepares visibility data for the existing
apartment and refines indirect lighting after lighting or material edits. Refinement
stops after convergence; the PBR shading pass continues to sample GI while settled.
Switching back to Baked restores the baked-lighting path. GI remains experimental,
with known coverage and reflection limitations.

Enable **Use time of day** in Environment to scrub the clock or use daylight presets.
Playback starts paused after reload. Disable time of day to restore the saved manual
sun direction and warmth. The cycle is artistic, not a location/date-accurate daylight
study. Brightness controls are artistic multipliers, not calibrated measurements.
Sun color also drives the light-shaft tint.

## Debug and benchmarks

**Debug** starts off on every load. It reveals a compact overlay with FPS, frame
interval, render dimensions, renderer, and GI state, plus a Debug category containing
benchmarks, probe diagnostics, indirect-only inspection, and Babylon Inspector.

Hiding Debug restores combined rendering and closes Babylon Inspector. An active
benchmark keeps its progress and Stop control available until the run ends.

Benchmark runs warm up for 15 seconds, then measure for 60 seconds. Exported results
include settings, camera state, render dimensions, revision, frame statistics,
available GPU timings, and shadow/render-graph diagnostics.

For comparable results, keep the device, camera route, viewport, render scale,
exposure, and lighting settings fixed. Test moving sunlight separately and repeat
after sustained device use. Keep Babylon Inspector closed during measurement.

- Frame interval is not GPU execution time.
- **Last GI dispatch** is a retained refinement measurement, not current whole-frame
  GPU cost. Unsupported measurements are shown as unavailable.
- The revision field identifies source HEAD; it does not identify uncommitted source
  used in a local build.
- Native-resolution 60 FPS on the user's iPhone remains an acceptance target, not a
  verified result. Desktop timings and emulated phone layouts do not establish it.
- Full eight-fixture acceptance is not established; prior stress testing encountered
  shader sampler and native light-count limits.

## Checks and production build

```powershell
npm test
npm run check
npm run build
npm run preview
```

The build includes TypeScript checking and writes `dist`. The Windows launcher also
supports `check`, `build`, and `preview`. Tests cover navigation, lighting, geometry,
materials, and rendering behavior.

Browser UI checks are available in `scripts/check-scene-ui-layout.cjs`,
`scripts/check-scene-ui-interaction.cjs`, and `scripts/check-scene-ui-touch.cjs`.
They require Playwright and Microsoft Edge. Set `PLAYWRIGHT_MODULE` if Playwright is
outside the project, `UI_URL` to the running viewer, and optionally `UI_OUTPUT` for
screenshots and JSON reports. For example:

```powershell
$env:UI_URL = 'http://127.0.0.1:5173/?scene=bukit-merah'
node scripts/check-scene-ui-layout.cjs
node scripts/check-scene-ui-interaction.cjs
node scripts/check-scene-ui-touch.cjs
```

Use the actual port printed by Vite. The layout check covers desktop, tablet,
portrait phone, and short landscape sizes. Real-device testing is still required.

## Assets and baking

The apartment preserves the supplied model's geometry and door positions, with a
visible ceiling and PBR paint, tile, veneer, glass, and metal. Active assets are in
`public/models/bukit-merah/pbr`; the supplied model and earlier baked assets are retained.

See the [apartment baked-lighting workflow](docs/lighting-workflow.md) for material
preparation, Blender baking, directional lightmaps, denoising, and asset verification.
That guide describes the baked path, not runtime probe GI. Review staged outputs
before replacing public assets. Material changes require a rebake for the baked path;
changing direct sun direction does not.

To reproduce the Sponza bake with Blender 4.5:

```powershell
blender --background --factory-startup --python-exit-code 1 --python scripts/bake-lighting.py
```

Review `.tools/baked-lighting` before copying outputs to `public/models/sponza/baked`.
Its two 4096 × 4096 RGB light/AO maps use about 96 MiB uncompressed. They have no
mipmaps to avoid mixing UV gutters; distant surfaces can alias.

Asset sources and licenses:

- [Sponza source](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/723ffc6706725b618b8c14ceb82e3e6904b08a76/Models/Sponza)
- [Environment source](https://github.com/BabylonJS/Assets/tree/8be9384c7f8728cb45d27975ac92a412f97a98dd/environments)
- [Sponza attribution](public/models/sponza/SOURCE.md)
- [Supplied licenses](public/LICENSES)
- [Asset revisions](public/ASSET-SOURCES.json)
- [Apartment material sources and hashes](public/models/bukit-merah/pbr/sources.json)

## Deployment and project notes

[GitHub Actions](.github/workflows/pages.yml) tests, builds, and publishes committed
source and assets to GitHub Pages on pushes to `main`. Repository Pages settings must
use GitHub Actions as the source. Vite uses relative asset URLs for deployment under
the repository subdirectory; CI uses the committed assets rather than downloading them.

The separate [GI preview](https://yanchn-lim.github.io/babylontest-probe-preview/?scene=bukit-merah)
has its own static-output repository and release history. Publishing it does not
update production.

Historical implementation and performance reports under `docs` describe the state
at the time of each experiment; their UI names and deployment claims may be outdated.
See [AGENTS.md](AGENTS.md) for project editing instructions.
