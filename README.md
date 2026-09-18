# Babylon apartment and lighting comparison

This project has three supported viewers, built with Babylon.js 9.25.0,
TypeScript and Vite.

The [lighting preparation lab](https://yanchn-lim.github.io/babylontest/preparation.html)
measures editor rebuilds with the apartment and 19 actual IKEA furniture pieces.
It includes reusable lighting atlases, active-sample tracing, exact hit packing
and GPU cache paging. See the [benchmark results](docs/preparation-benchmark.md)
and [editor integration guide](docs/lighting-scene-interface.md).

[Open the published lighting comparison](https://yanchn-lim.github.io/babylontest/comparison.html).

| Viewer | Local route | Purpose |
| --- | --- | --- |
| Lighting comparison | `/comparison.html` | Compare a small real-time scene against matched offline Cycles renders. |
| Apartment lighting study | `/apartment.html` | Walk through the fixed apartment with cached diffuse lighting, four bounces and time-of-day controls. |
| Lighting preparation lab | `/preparation.html` | Measure apartment + furniture rebuilds with manual trials, batch controls and cache checks. |

[Open the apartment lighting study](https://yanchn-lim.github.io/babylontest/apartment.html).
See the [apartment study guide](docs/apartment-transfer.md) for preparation and limits.
See the [preparation lab guide](docs/preparation-benchmark.md) for rebuild measurements.

The root route `/` redirects to the current apartment viewer. The original viewer is retired.
All active viewers share the approved graphics defaults in `src/graphics/`.
The comparison uses cached diffuse GI with four bounces, live direct lighting
and shadows. Controls cover scene selection, time of day, Auto / On / Off interior
lights, walking, saved cameras, and side-by-side or overlay offline comparison.
The room falls back to baked lighting on WebGL; furniture GI requires WebGPU.

Furniture scenes are available in the Scene menu:

- [KLIPPAN](https://yanchn-lim.github.io/babylontest/comparison.html?study=couch&lights=on)
- [ÄPPLARYD](https://yanchn-lim.github.io/babylontest/comparison.html?study=applaryd&lights=on)

ÄPPLARYD uses the tested correction for ray origins and invalid lighting samples.
Some cushion seams remain unresolved. Old renderer, offset and material A/B
variants have been removed; earlier versions remain in Git checkpoints.

The comparison is an experiment. GI artifacts, reflection accuracy and actual
phone performance remain open.
See [project goals](PROJECT_GOALS.md).

## Run locally

Use the Windows launcher to select the project's Node 24 runtime:

```powershell
.\run.ps1 setup
.\run.ps1 dev
```

Setup installs pinned dependencies and downloads the apartment environment
texture and its attribution. Apartment and comparison assets are already in
`public`. Open the address printed by Vite, then use either route above.

With Node 24 already on PATH:

```powershell
npm ci
npm run dev
```

## Check and build

```powershell
.\run.ps1 check
.\run.ps1 build
.\run.ps1 preview
```

`npm test` runs the remaining unit and asset checks with Node 24. Browser checks
are separate; they require Playwright and Edge. Run only the checks relevant to
the change. The comparison check and its environment variables are documented
in [the comparison guide](docs/remake-comparison.md).

## Project map

| Path | Responsibility |
| --- | --- |
| `src/graphics/` | Shared display defaults and local reflection visibility. |
| `src/interior-lighting/` | Original apartment probe GI, fixtures and geometry preparation. |
| `src/comparison/` | Comparison renderer, lighting controls, lightmaps and navigation. |
| `public/models/bukit-merah/` | Original apartment assets, source attribution and bake metadata. |
| `public/comparison/` | Comparison geometry, lighting maps, references and provenance. |
| `scripts/` | Asset preparation and focused checks for the active viewers. |
| `tests/` | Unit and asset tests; retained regression data lives in `tests/fixtures/`. |
| `.tools/` | Ignored local runtimes, intermediate renders, captures and logs. |

## Guides

- [Current goals and scope](PROJECT_GOALS.md)
- [Original apartment bake workflow](docs/lighting-workflow.md)
- [Comparison scene and reference preparation](docs/remake-comparison.md)
- [Apartment source and attribution](public/models/bukit-merah/SOURCE.md)
- [Environment attribution](public/LICENSES/BabylonAssets.txt)

Asset generation is a separate offline step. A normal build uses the existing
assets and does not launch Blender or rebake lighting.
