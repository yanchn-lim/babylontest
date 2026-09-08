# Bukit Merah Ridge 4-room apartment

Source: `flat-native.glb`, supplied by the user. `Apartment.glb` preserves that
file unchanged, including embedded textures and door positions. Source and asset
hashes are recorded in `asset.json`.

The viewer loads a derivative in `baked/`, with a second UV set, baked ambient
occlusion, and baked skylight. Original material definitions and texture pixels
are retained. The ceiling is included in the bake and remains visible in all views.
Baked settings and hashes are recorded in `baked/lighting.json`.
Sunlight, soft shadows, light shafts, and bloom remain real time.
