# Apartment lighting workflow

This guide describes the current Bukit Merah Ridge lighting. It uses the existing model, ceiling, materials, and baked UV atlas. A lighting rebake does not export or change the model.

## How the image is built

| Layer | Source | Purpose |
| --- | --- | --- |
| Baked diffuse skylight | Blender Cycles, stored in `indirect.png` | Soft interior illumination and light reflected between static surfaces |
| Ambient occlusion (AO) | Existing `baked/ao.png` | Extra shading where surfaces meet |
| Direct sun and shadows | Babylon directional light and shadow map | Movable sunlight with realtime surface shadows |
| Environment lighting | Prefiltered environment texture | Reflections and adjustable diffuse fill |
| Sun shafts | Babylon volumetric lighting | Visible light in the air |
| Image processing | HDR, bloom, ACES tone mapping, FXAA | Highlight glow, display brightness, and edge smoothing |

Despite its name, `indirect.png` includes both direct **sky** illumination and indirect diffuse bounce, with material color. The bake contains no directional sun. Moving the sun changes direct light, shadows, and shafts, but does not change baked skylight or create new sunlight bounce.

The visible sky shader is separate from the uniform sky used for baking. Changing the visible sun or sky does not rebake the apartment.

## Files to know

- [Current model and materials](../public/models/bukit-merah/pbr/Apartment.gltf)
- [Bake settings, input hashes, and lightmap metadata](../public/models/bukit-merah/pbr/lighting.json)
- [Current-material bake script](../scripts/rebake-apartment.py)
- [Denoise script](../scripts/denoise-apartment.py)
- [Material generator](../scripts/prepare-apartment-materials.py)
- [Babylon lighting setup](../src/main.ts)
- [Lighting preset and saved preferences](../src/graphics-settings.ts)

UV0 supplies material texture coordinates. UV1 supplies the existing baked-light and AO coordinates. Keep these channels intact. The workflow below updates only the active lightmap and its metadata; it leaves AO unchanged.

## 1. Prepare the current materials

For a lighting-only rebake, use the existing files in `public/models/bukit-merah/pbr`. Do not run the original model export or original atlas-generation pipeline.

The current finishes use clean warm-white paint with scanned normal and roughness detail, pale porcelain tiles, and natural veneer. Their color affects the baked diffuse result.

If materials were regenerated with `scripts/prepare-apartment-materials.py`, run the full bake and denoise sequence below afterward. The material generator produces an approximate recolored lightmap, not a fresh lighting simulation.

## 2. Bake diffuse skylight

Run commands from the repository root in PowerShell. The current Windows setup uses Blender 4.5.3 with AMD HIP support. The script selects HIP devices and uses CPU if none are found. Other Blender builds or GPU backends can require changes to device selection.

```powershell
& .\.tools\blender-4.5.3-windows-x64\blender.exe `
  --background --factory-startup --disable-autoexec --python-exit-code 1 `
  --python scripts/rebake-apartment.py
```

The script imports the current glTF into a temporary Blender scene. It joins meshes there for baking, but does not export that joined model. Material textures use UV0; the bake targets UV1. Paint normal detail is disabled only in this temporary bake scene, so the lightmap stores broad illumination rather than fixed paint microdetail. The runtime paint normal map remains unchanged.

| Setting | Current value |
| --- | --- |
| Engine | Cycles |
| Texture size | 4096 x 4096 |
| Samples | 1024, adaptive sampling off |
| Seed | 23 |
| Maximum bounces | 6 |
| Diffuse bounces | 4 |
| Sky color, linear RGB | `[0.8, 0.85, 1.0]` |
| Sky strength | 1.4 |
| Bake passes | Diffuse direct, indirect, and color |
| Bake margin | 1 pixel, extended |
| Blender denoising | Off; external denoising follows |

Sky values come from the active `lighting.json`; sample count and resolution are defined in the bake script. These values are the current configuration, not a physically calibrated daylight measurement.

Wait for `REBAKE COMPLETE`. Raw output is staged in `.tools/apartment-pbr-rebaked/` as `indirect-linear.npy` (linear float32 RGB), a preview `indirect.png`, and `lighting.json`. Check that the process completed successfully before proceeding; an old staged file is not proof that a new bake succeeded.

### Encoding and brightness

The script stores floating-point light in an 8-bit RGB PNG using gamma 2.2 and a recorded linear scale:

```text
encoded = (linear light / lightmapScale) ^ (1 / 2.2)
```

The scale is selected from the bake peak so the PNG can hold the lighting range. The current scale is 2. Babylon marks the texture as gamma encoded and restores this scale. That factor is necessary decoding, not an extra artistic brightness boost.

The separate Baked light strength control multiplies the restored result. A value of 1 keeps the recorded bake strength. The balanced preset uses 0.65 to give realtime surface shading more influence.

## 3. Denoise the raw bake

Use Python with NumPy and Pillow installed. The script expects the Windows Open Image Denoise 2.3.3 package at `.tools/oidn-2.3.3.x64.windows/bin`.

```powershell
python scripts/denoise-apartment.py --pbr-rebake
```

The `--pbr-rebake` flag is required for this workflow. Without it, the script uses the older `baked` asset directory.

The denoiser verifies the float intermediate against its recorded hash, checks its dimensions and pixels, then applies OIDN's `RTLightmap` filter separately to each UV island. It extends each island into a padded region before filtering, writes only that island's pixels back, and restores a one-pixel edge margin. This prevents filtering across unrelated surfaces in the atlas. Paint islands are filtered at quarter resolution and resized back in linear light to suppress larger noise patches. This smooths baked illumination detail on paint; runtime wall normals are retained. Tile and wood islands keep full-resolution filtering. The current atlas has 973 islands. The PBR workflow filters the float pixels directly and converts to the final 8-bit PNG only afterward. It requires a fresh float bake; it does not silently fall back to the preview PNG.

Wait for `Denoising complete`. Review both staged files in `.tools/apartment-pbr-denoised/`. Do not denoise an already denoised lightmap; the script rejects metadata that already records a denoise pass.

## 4. Publish the reviewed pair

Keep a backup or Git revision of the active files. After checking the staged result, replace both files together:

```powershell
Copy-Item -LiteralPath .tools/apartment-pbr-denoised/indirect.png `
  -Destination public/models/bukit-merah/pbr/indirect.png
Copy-Item -LiteralPath .tools/apartment-pbr-denoised/lighting.json `
  -Destination public/models/bukit-merah/pbr/lighting.json
```

The metadata records input hashes, encoding scale, bake statistics, and denoising provenance. It also contains the final PNG hash used for asset versioning. Copying the PNG alone can leave its scale or version information out of sync.

With the project Node installation available on PATH, run:

```powershell
npm test
npm run build
npm run dev
```

Open the local viewer with `?scene=bukit-merah`. Review the result before committing and deploying the two assets. After deployment, confirm the deployed revision and lightmap hash match the reviewed files.

## 5. Balance the lighting in Babylon

Start with **Settings > Sun & lighting > Apply balanced lighting**. Saved custom settings persist across reloads and scene changes, so new defaults do not overwrite them automatically.

| Control | Balanced value | Effect |
| --- | --- | --- |
| Sun brightness | 3 | Direct sunlight |
| Environment brightness | 0.65 | Environment reflections and diffuse light |
| Diffuse environment fill | 0.65 | Diffuse environment contribution, independently of reflections |
| Baked light strength | 0.65 | Multiplier on decoded baked lighting |
| Ambient occlusion strength | 1 | Strength of the separate AO texture |
| Exposure | 1.9 | Overall image exposure before display mapping |
| Contrast | 1 | Image contrast |

The preset leaves sun direction, shadow quality, render scale, bloom, and shafts unchanged. Exposure and contrast controls are in Image & performance.

Balance one contribution at a time:

1. Set the desired sun direction, then adjust Sun brightness for direct illumination.
2. Adjust Baked light strength for the interior's static sky illumination.
3. Use Environment brightness for reflections, then Diffuse environment fill to control extra fill. Both controls affect the final diffuse environment contribution.
4. Adjust AO only if the extra contact shading is too strong. Reducing AO cannot remove occlusion already present in the baked lightmap.
5. Set exposure after the lighting balance is close. Keep bloom subtle so highlights retain detail.

Light strength controls apply at runtime without rebaking or rebuilding the render graph. Surface shadows are cached until a relevant change, such as sun movement, requires an update. Shafts use a separate depth map and throttled lighting-volume updates.

## Checks and limits

Compare images with the same camera position, sun direction, exposure, and render dimensions. Inspect ceiling corners, doorways, wall texture, grout, wood, and glass. Walk through the apartment to check seams and distant surfaces as well as a still image.

The current atlas has narrow gutters. Baked texture mipmaps are disabled to avoid light bleeding between islands. Denoising removes sample noise; it does not repair UV seams or incorrect illumination.

Changes to material color or baked sky lighting require a fresh bake for a matching result. Exposure, sun direction, and runtime strength adjustments do not. The baked result remains static and cannot reproduce changing sunlight bounce. This is the tradeoff that keeps the sun movable while retaining inexpensive interior lighting.

Use the in-app benchmark on the actual iPhone after visual checks. Keep walking and moving-sun measurements separate. A successful build or a smooth desktop preview does not establish mobile performance.
