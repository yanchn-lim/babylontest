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
The asset download verifies the geometry buffer length against the glTF manifest.

## Viewer

Drag on the canvas to look. Use WASD or arrow keys to move.
Select Atrium, Reverse atrium, or Upper overview to reset the camera.
Controls expose shadow resolution, exposure, render scale, FXAA, and the Babylon inspector.

The initial renderer uses WebGL, preferring WebGL 2 where available.
Lighting uses one directional sun, a weak hemispheric fill, and a prefiltered
environment map with ACES tone mapping. This is an initial real-time lighting
baseline; it does not implement bounced global illumination, ambient occlusion,
or WebGPU yet. Camera movement has no collision detection.

For comparisons, hold the camera view, browser, GPU, viewport, render scale,
and exposure constant. Frame time is the interval between rendered frames,
not a GPU timing measurement. Keep the inspector closed when comparing performance.
The environment supplies approximate ambient lighting and reflections.

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
