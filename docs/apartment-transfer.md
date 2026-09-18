# Apartment cached diffuse study

Approved display and reflection changes now use shared defaults across all active
viewers. See [the current graphics policy](../PROJECT_GOALS.md#shared-graphics-defaults).
The original viewer is retired; `/` opens the current apartment.

Open `/apartment.html` for the comparison renderer applied to the fixed Bukit
Merah apartment. `/` redirects here, and `/comparison.html` retains
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

Apartment artificial lights use a runtime intensity scale of 0.35. The same scale
applies to direct lighting and cached diffuse lighting; reflections capture the
result. Prepared light positions, cache validation and visibility are unchanged,
so this intensity adjustment does not require cache regeneration. Exposure,
daylight and material settings retain their previous values. The previous look
is saved at `checkpoint/apartment-before-light-balance-2026-09-17` (`4ca786b`).

The apartment keeps its 256×256 GI texture and applies one 3×3 blur after the final
bounce. The filter stays within connected lighting regions and checks surface
direction, distance and brightness differences to preserve boundaries. It reuses
the existing buffers and adds one dispatch per lighting update. It softens sample
variation but does not repair light leaks. The filter runs only on WebGPU;
all active cached viewers share it.

The apartment's runtime GI output stores received diffuse light (irradiance / pi),
before multiplying by the receiving surface's colour. Each propagated bounce
still uses the prepared coarse albedo and metallic fraction. The final material
shader applies native full-resolution base colour and metalness. This restores
tile joints and wood grain under indirect light without changing ray visibility,
transport weights, bounce count or atlas size. No division by coarse albedo is used,
so black or fully metallic samples cannot cause unstable colour ratios.

The final blur also excludes samples whose cached rays have more than 75% back-face
hits. Counts come from the difference between all 1,024 rays, stored front-face hit
weights and sky misses. A spare surface component stores validity; output alpha
stores the interpolation weight. The material normalizes the filtered RGB by this
weight. This prevents mostly embedded samples from darkening visible edges, as
confirmed at the bedroom ceiling where samples sit behind the adjoining wall.
Transport remains unchanged. If all four interpolation samples are invalid, the
result stays dark; this does not repair geometry or guarantee leak-free lighting.
The mask adds no GPU buffers or dispatches. WebGL retains its baked fallback.
The active cached viewers share received-diffuse material handling; prepared
geometry and scene-specific sample corrections remain separate inputs.

The apartment adds subtle HDR bloom before ACES tone mapping: strength 0.5,
threshold 0.7, kernel 32 and half-resolution filtering. The camera retains 4× MSAA.
Exposure is unchanged. Bloom runs on the camera image, outside reflection capture
and offline cache preparation. All active viewers share these display defaults.
Phone performance remains untested.

The apartment also enables output dithering at intensity 1/255 in its final
image-processing pass after bloom. This reduces display colour banding without
changing GI or adding blur.

The Bloom settings panel offers live strength (0–1), threshold (0–3) and spread
(8–128) sliders. Strength 0 removes the glow. Lower threshold includes dimmer
surfaces; spread controls the blur kernel width. Reload restores the defaults.
These controls do not update GI or reflection captures.

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

The original model and its baked UVs are unchanged. At the user's request, the
remake no longer splits GI triangles at wall intersections. Preparation and the
viewer both use the original 2,160 triangles. A regenerated padded 256px lighting
atlas is applied to UV3. Connected coplanar sections share a chart unless a wall
blocks their join. There are 515 charts with 40.7% chart coverage.
Ray sample positions keep 8 mm of clearance from triangle edges where space allows
to avoid starting on adjoining walls; the traced geometry itself is unchanged.
The original baked skylight stays visible while the cache loads and on WebGL.
That fallback scales with sky brightness; it does not update indirect sun or lamp
light. It is not a matched reference for the new method.

This is an apartment prototype. The compact atlas can lose lighting detail on
small surfaces. Removing the intersection split can reintroduce corner leakage;
the metallic-texture fix addresses a separate furniture-darkening issue. No
apartment Cycles match or physical iPhone performance result is claimed. Review
visuals before choosing a final atlas or memory budget.

The prepared cache downloads 14.9 MB and uses about 41.2 MB for GI buffers and its
output texture, excluding model textures and shadow maps. A four-bounce update
uses nine dispatch stages, including the final blur. Reflection-room partitioning still divides the render
meshes to assign local probes; it does not change the prepared GI geometry.
Desktop timing is not a GPU completion or phone measurement.

The apartment blends each room probe into the existing hall probe within 0.5 m
of its X/Z partition edges. Both sides meet at the same capture, removing abrupt
reflection brightness changes across the continuous floor. The blend uses each
probe's box projection and the existing roughness filtering. It changes only
specular radiance; GI, textures, geometry and the nine captures stay unchanged.
It adds one cubemap binding per room material and one extra lookup inside the
transition band. This is a simple shared-boundary approximation: the hall capture
also influences surfaces near solid room edges and is not an accurate reflection
of every neighbouring room. Phone cost has not been measured.

## Regenerate the apartment cache

Regenerate after geometry, UV, material, fixture-position or sampling changes.
The atlas script validates the current single-mesh glTF layout. `scene.json`
contains the exact transport geometry, albedo samples and light settings used
to generate the cache. A fingerprint rejects mismatched scene/shader caches.

The exporter samples metallic textures as linear data at 128px resolution.
Diffuse colour uses `baseColor * (1 - metallicFactor * metallicTexel)`, with
the metallic texture's UV set, transform, wrap modes and blue/red channel.
Materials without a metallic map keep their scalar-only calculation. Existing
exports made without metallic-texture support must regenerate both `scene.json`
and the transfer cache; updating the viewer alone cannot repair those exports.
This does not fix overlapping furniture lightmap charts.

For the focused material check, run a Vite development server on port 4193 and
run `node scripts/check-metallic-transfer.cjs`. Set `SOFA_MODEL_URL` to a served
KLIPPAN 49010615 GLB to also check the reported furniture case. This optional
asset is not included in the repository. The check isolates material handling
with separate triangle charts; it is not a full-room visual comparison.

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
