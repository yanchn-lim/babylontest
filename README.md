# Babylon.js Sponza lab

A local TypeScript and Vite viewer for testing Babylon.js graphical fidelity.

## Windows setup

Run in PowerShell:

```powershell
.\run.ps1 setup
.\run.ps1 dev
```

The launcher downloads a SHA-256-checked Node.js 24.19.0 runtime into the ignored
`.tools` directory. It does not replace your system Node installation.
Setup installs the pinned packages and downloads the Sponza model, 69 textures,
environment lighting, and attribution into `public`.
Open the local address printed by Vite. Stop the server with Ctrl+C.

With your own supported Node installation (22.12+), use `npm ci`,
`npm run assets`, and `npm run dev` after the lockfile exists.

## Checks and builds

```powershell
.\run.ps1 check
.\run.ps1 build
.\run.ps1 preview
```

The build runs TypeScript checking and produces `dist`.
Run `npm test` with Node 24 to check flight speed, simultaneous touch input,
release/cancel handling, and stopping on focus changes. CI runs these tests before building.
The asset download verifies the geometry buffer length against the glTF manifest.

## Viewer

On keyboard and mouse, click the scene and use WASD or arrow keys to fly.
E rises, Q descends, and Shift increases speed. Drag to look, or use Capture mouse
for continuous mouse look; Esc releases the pointer.
On mobile, use the left stick to fly, drag the scene to look, and hold Up or Down
to change height. Movement, looking, and height controls support simultaneous touches.
Forward flight follows the camera view. Up and down follow the world vertical axis.
Movement stops when controls are released, focus changes, or the page is hidden.
Scene settings can be expanded or collapsed to leave space for the viewer.
Select Atrium, Reverse atrium, or Upper overview to reset the camera.
Controls expose shadow resolution, exposure, render scale, FXAA, and the Babylon inspector.

The initial renderer uses WebGL, preferring WebGL 2 where available.
Lighting uses one directional sun, baked ambient occlusion (AO), baked diffuse
sunlight bounce, and a prefiltered environment map with ACES tone mapping.
AO reduces ambient light in crevices. The indirect lightmap adds sunlight that
bounces off surfaces; direct sunlight and shadows remain real time.
Camera movement has no collision detection. WebGPU is not enabled.

For comparisons, hold the camera view, browser, GPU, viewport, render scale,
and exposure constant. Frame time is the interval between rendered frames,
not a GPU timing measurement. Keep the inspector closed when comparing performance.
The environment supplies approximate reflections; diffuse skylight is baked.

## Assets

Sponza source:
https://github.com/KhronosGroup/glTF-Sample-Assets/tree/723ffc6706725b618b8c14ceb82e3e6904b08a76/Models/Sponza

Environment source:
https://github.com/BabylonJS/Assets/tree/8be9384c7f8728cb45d27975ac92a412f97a98dd/environments

Downloaded attribution is in `public/models/sponza/SOURCE.md`.
The supplied licenses are in `public/LICENSES`.
Asset revisions are recorded in `public/ASSET-SOURCES.json`.
Models and textures remain trackable; generated build files, dependencies,
the portable runtime, and `agent.md` are ignored.

## GitHub Pages

The GitHub Actions workflow in `.github/workflows/pages.yml` builds and publishes
the committed source and assets on each push to `main`.
In repository Settings > Pages, select GitHub Actions as the deployment source.
Vite uses relative URLs so the viewer also works under a repository subdirectory.
The model and textures are committed in `public`; CI does not download them again.

## Baked lighting

The viewer loads `public/models/sponza/baked/Sponza.gltf` with a separate UV set
for two 4096×4096 maps. Blender Cycles bakes 512 samples with four diffuse bounces.
The original materials and textures are preserved. AO uses a one-unit distance.
The lightmap combines sunlight bounce with direct and bounced diffuse skylight.
The sky is a uniform world with linear color (0.8, 0.85, 1.0) and strength 1.4.
Direct sunlight stays real time. The environment map supplies specular reflections;
its diffuse contribution is disabled to avoid counting skylight twice.
The artificial hemispheric fill is removed.

To reproduce with Blender 4.5 and an AMD HIP device:

```powershell
blender --background --factory-startup --python-exit-code 1 --python scripts/bake-lighting.py
```

Outputs are staged in `.tools/baked-lighting`. Review them before copying the five
output files to `public/models/sponza/baked`. `lighting.json` records the settings,
source hash, and output hashes. Tests check the committed assets.
Changes to geometry, materials, or the sun require a new bake. Disabling real-time
shadows does not remove baked shading. Maps use no mipmaps to avoid mixing their
small UV gutters; distant surfaces can alias. Two RGB maps use about 96 MiB of
uncompressed texture memory, which adds memory pressure on mobile devices.

Bloom uses Babylon's native FrameGraphBloomTask at half resolution, weight 0.12,
kernel 32, and threshold 1.0, before ACES tone mapping.
