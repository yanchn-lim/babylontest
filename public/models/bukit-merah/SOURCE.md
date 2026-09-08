# Bukit Merah Ridge 4-room apartment

Source: `flat-native.glb`, supplied by the user. `Apartment.glb` preserves that
file unchanged, including embedded textures and door positions. Source and asset
hashes are recorded in `asset.json`.

The base derivative in `baked/` has a second UV set, baked ambient
occlusion, and baked skylight. Original material definitions and texture pixels
are retained. The ceiling is included in the bake and remains visible in all views.
Baked settings and hashes are recorded in `baked/lighting.json`.
Sunlight, soft shadows, light shafts, and bloom remain real time.

The viewer loads `pbr/Apartment.gltf`, which replaces plaster, tile, wood, and
concrete surfaces with 1K Poly Haven CC0 PBR textures. Glass, metal, geometry,
and baked UVs are retained. `pbr/sources.json` records source URLs and hashes.
The denoised lightmap is retinted for the new base colors; bounced-light colors
remain approximate. `pbr/lighting.json` records this conversion and its hashes.
