# Remake comparison scene

`/comparison.html` uses cached dense diffuse lighting with four indirect bounces.
Select Room, KLIPPAN or ÄPPLARYD. The original apartment viewer at `/` and the
remake apartment at `/apartment.html` remain separate.

## Controls

- Walk with W/A/S/D, arrow keys or the touch pad. Drag to look.
- Change time from 00:00 to 24:00. Interior lights use Auto, On or Off.
  Auto turns lights on before 07:00 and from 18:00.
- Choose either saved camera or reset after walking.
- The room has 12 matched Cycles references. Compare side by side or with an
  opacity overlay. Walking and unmatched times hide the reference.

The renderer and bounce count are fixed. Old radiance-cascade, metallic-factor,
mesh-density, offset and mirror diagnostic choices have been removed. Earlier
versions remain in the existing Git checkpoint tags.

The room uses local reflections. Furniture retains the diffuse study settings.
Room lighting falls back to baked maps on WebGL or when the transfer cache fails.
Furniture has no baked/reference lighting and reports direct-only fallback.

## Lighting implementation

Offline preparation traces 1,024 fixed cosine-weighted rays per sample in a
256-by-256 surface atlas. Repeated target hits become integer weights. Cached
visibility supplies sky and fixed lamps; current sun visibility is traced live.
Four bounces use eight compute dispatches. Walking reuses the finished texture.
This is cached surface diffuse transfer, not radiance cascades or path tracing.

`surface-geometry.ts` prepares samples and the BVH. `cached-transfer.ts` runs the
lighting updates. `transfer-data.ts` validates the scene/shader fingerprint.
`transfer-tracing.wgsl` retains the shared shader text used to create the existing
scene caches, including unused historical entry points. The cascade scheduler
has been removed; those entry points are never dispatched.

ÄPPLARYD additionally uses `sample-repair.ts`:

- Positions and interpolated normals use the same clamped triangle coordinates.
- The triangle-centre inset is disabled. Ray origins move along geometric normals
  by four times a scale-aware minimum, approximately 40 micrometres in this room.
- More than 25% backface hits marks a sample invalid. A donor must be within the
  same chart and 6 cm, have normal dot product at least 0.8, and at most 5%
  backface hits. Unmatched samples retain their result.
- The prepared map replaces 2,725 samples. Some front-fold artifacts remain.

The correction is an approximation and is enabled only in ÄPPLARYD's scene data.
Other prepared scenes retain their tested geometry/shader behavior. No offline
reference exists for the couches. Cycles parity, phone performance and final
download/memory budgets remain unverified.

## Preparation and checks

Use `scripts/prepare-comparison.py` with Blender to prepare the original room and
Cycles references. `scripts/prepare-couch-study.cjs` and `scripts/unwrap-couch.py`
prepare furniture geometry and lighting UVs; set `COUCH_STUDY` to `couch` or
`applaryd`. Sources and attribution are beside each model in `public/comparison`.

Generate transfer data using a built local preview. The default preparation URL
is `http://127.0.0.1:4185/comparison.html`, and the output is `public/comparison`.

```powershell
node scripts/prepare-comparison-transfer.cjs

# Furniture example (its corrected directory is the single retained cache).
$env:COMPARISON_URL = "http://127.0.0.1:4185/comparison.html?study=applaryd"
$env:TRANSFER_OUTPUT_DIR = "public/comparison/applaryd/corrected"
node scripts/prepare-comparison-transfer.cjs
```

Preparation regenerates the repair map when enabled and saves the updated scene
JSON beside the furniture's cache directory. Rebuild after asset generation.
Geometry, materials, lighting atlas, fixture positions or sampling changes require
new transfer data. Do not bypass fingerprint validation.

`node scripts/check-comparison.cjs` is the focused smoke check. Set `COMPARISON_URL`
to the local comparison page. It covers all three scenes, time/lights, walking,
offline comparison and WebGL fallback. Use `npm run check` and `npm run build`
for TypeScript and production bundle checks. Run further tests only when needed.
