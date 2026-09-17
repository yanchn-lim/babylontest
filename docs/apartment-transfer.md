# Apartment cached diffuse study

Open `/apartment.html` for the comparison renderer applied to the fixed Bukit
Merah apartment. `/` remains the original viewer, and `/comparison.html` retains
the small scene and its Cycles references.

The apartment uses the same dense diffuse transfer method: 1,024 fixed hemisphere
rays per lighting sample, exact integer hit weights, and one to four bounces.
Four bounces are selected initially. Time changes update sun and sky; seven fixed
room lights support Auto, On and Off. Auto is on before 07:00 and from 18:00.
Walking reuses the last complete lighting texture. Drag to look, use WASD to walk,
or use the touch pad. Three saved views cover the living room, hall and bedroom.

Native glTF materials retain their textures, normal maps, roughness and metalness.
Diffuse transport samples compact linear albedo maps and removes the metallic
fraction. Glass is clear to transport and shadow rays; visible glass keeps its
native material. Local probes approximate glossy reflections. Tint, refraction
and recursive reflections between reflective surfaces are not solved.
The live sun and point lights use the comparison's filtered shadow settings,
MSAA and ACES display transform. Seven lamps plus the sun fit the portable
eight-light material limit.

## Local reflections

The diffuse-only state is preserved at tag
`checkpoint/apartment-diffuse-2026-09-17` (`37c34f2`). Select **Reflections → Off**
to compare its lighting with the new reflection layer.
The first reflection version is preserved separately at
`checkpoint/local-reflections-2026-09-17` (`d730bc5`).

Nine local probes cover the living room, three bedrooms, two bathrooms, kitchen,
shelter and hall. Each captures a linear HDR cubemap at 128 pixels per face,
including the current diffuse GI and direct lights. GGX filtering supplies the
material roughness levels. A room-sized box corrects reflection placement.
The maps contribute only specular light: their diffuse spherical coefficients
are zero. Existing environment reflections are suppressed during capture to
avoid recursive feedback. The comparison page uses one probe in its main room;
its sphere is omitted from capture to avoid reflecting itself.

The shared `LocalReflectionFilter` adjusts the cubemap lookup toward the dominant
direction of a rough specular lobe, including its change at grazing angles. It
uses the [Frostbite/HDRP approximation](https://github.com/Unity-Technologies/Graphics/blob/master/Packages/com.unity.render-pipelines.core/ShaderLibrary/ImageBasedLighting.hlsl).
The material's roughness, reflectance, direct-light response and diffuse GI are
unchanged. This adds shader arithmetic, with no additional texture samples,
captures or GPU buffers. It improves the reflection approximation but cannot
recover objects hidden from the probe or reproduce every path-traced highlight.

Captures update after the diffuse lighting finishes. The previous complete set
stays visible until the replacement is ready. Walking and reflection On/Off
switching reuse the maps. A change during capture discards the stale set.
WebGL uses the same reflections over its baked diffuse fallback.

Apartment render meshes are clipped at room boundaries to give each piece its
own material/cubemap. Vertex attributes, UVs and surface area are preserved;
the source model and prepared GI cache are unchanged. This increases draw calls.
The probes are approximate, with possible seams between rooms, limited detail
and inaccurate nearby-object reflections. They are not mirror or ray-traced
reflections. Physical iPhone performance remains untested.

The original model and its baked UVs are unchanged. The new page expands its
vertices at load time and applies a separate, padded 256px lighting atlas to UV3.
Coplanar surfaces share lighting charts to reduce seams between wall sections.
The original baked skylight stays visible while the cache loads and on WebGL.
That fallback scales with sky brightness; it does not update indirect sun or lamp
light. It is not a matched reference for the new method.

This is an apartment prototype. The compact atlas can lose lighting detail on
small surfaces. Remaining light leaks are accepted for this pass; their cause
has not been isolated. No apartment Cycles match or physical iPhone performance
result is claimed. Review visuals before choosing a final atlas or memory budget.

The prepared cache downloads 9.5 MB and uses about 29.3 MB for GI buffers and its
output texture, excluding model textures and shadow maps. The focused desktop
check scheduled a four-bounce update in about 58 ms, including eight frames of
dispatch scheduling. This is not a GPU completion or phone timing.

## Regenerate the apartment cache

Regenerate after geometry, UV, material, fixture-position or sampling changes.
The atlas script validates the current single-mesh glTF layout. `scene.json`
contains the exact transport geometry, albedo samples and light settings used
to generate the cache. A fingerprint rejects mismatched scene/shader caches.

With the bundled tools, from the repository root in PowerShell:

```powershell
& .\.tools\blender-4.5.3-windows-x64\blender.exe -b -t 4 --python scripts/prepare-apartment-atlas.py
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/vite/bin/vite.js build
# Run this preview in another terminal and leave it running:
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4185
```

Then generate the cache and rebuild so the preview serves the new files:

```powershell
$env:COMPARISON_URL = 'http://127.0.0.1:4185/apartment.html'
$env:TRANSFER_OUTPUT_DIR = 'public/apartment-transfer'
& .\.tools\node-v24.19.0-win-x64\node.exe scripts/prepare-comparison-transfer.cjs
Remove-Item Env:COMPARISON_URL, Env:TRANSFER_OUTPUT_DIR
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/typescript/bin/tsc --noEmit
& .\.tools\node-v24.19.0-win-x64\node.exe node_modules/vite/bin/vite.js build
& .\.tools\node-v24.19.0-win-x64\node.exe scripts/check-apartment-transfer.cjs
```

The focused browser check covers daylight/night, automatic/manual lamps, bounce
selection, stable GI while walking, and the WebGL fallback. It captures the three
views for visual review under `.tools/apartment-transfer`. The preparation report
records cache size, ray counts and errors. Desktop update timings include frame
scheduling and are not GPU-only or phone measurements.

For reflection changes, `scripts/check-reflections.cjs` checks both pages on
WebGPU and WebGL, day/night captures, reflection switching, unchanged diffuse
GI and captures while walking, queued lighting changes, capture disposal, and
preservation of apartment surface area. Captures are under `.tools/reflections`.
