"""Bake Sponza AO, diffuse sunlight bounce, and diffuse skylight with Blender 4.5.
Run: blender --background --factory-startup --python scripts/bake-lighting.py
Outputs are staged in .tools/baked-lighting for review before publication.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import struct
import zlib

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/sponza"
OUTPUT = ROOT / ".tools/baked-lighting"
SIZE = 4096
SAMPLES = 512
AO_DISTANCE = 1.0
SUN_DIRECTION = [-0.5, -1.0, -0.35]
SUN_INTENSITY = 3.0
SKY_COLOR = [0.8, 0.85, 1.0]
SKY_STRENGTH = 1.4

def log(message):
    print("BAKE: " + message, flush=True)

def png(path, rgb):
    # Blender stores bottom-up rows; PNG and exported glTF UVs use top-down rows.
    pixels = np.flipud(np.clip(rgb, 0, 255).astype(np.uint8))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    rows = b"".join(b"\0" + row.tobytes() for row in pixels)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
    path.write_bytes(data)

def read_pixels(image):
    data = np.empty(SIZE * SIZE * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    data = data.reshape(SIZE, SIZE, 4)
    if not np.isfinite(data).all():
        raise RuntimeError("Bake contains non-finite pixels")
    return data

OUTPUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE / "Sponza.gltf"))
scene = bpy.context.scene
objects = [obj for obj in scene.objects if obj.type == "MESH"]
if len(objects) != 1:
    raise RuntimeError("Expected the pinned Sponza source to contain one mesh")
obj = objects[0]
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
mesh = obj.data
original_uv = mesh.uv_layers[0]
bake_uv = mesh.uv_layers.new(name="LightmapUV")
mesh.uv_layers.active = bake_uv
log("Creating a unique second UV set")
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=2 / SIZE, margin_method="FRACTION")
bpy.ops.object.mode_set(mode="OBJECT")
mesh = obj.data
original_uv = mesh.uv_layers[0]
bake_uv = mesh.uv_layers["LightmapUV"]
mesh.calc_loop_triangles()
uv_values = np.empty(len(bake_uv.data) * 2, dtype=np.float32)
bake_uv.data.foreach_get("uv", uv_values)
triangle_uvs = uv_values.reshape(-1, 2)[np.array([triangle.loops for triangle in mesh.loop_triangles])]
edge_a = triangle_uvs[:, 1] - triangle_uvs[:, 0]
edge_b = triangle_uvs[:, 2] - triangle_uvs[:, 0]
uv_coverage = float(np.abs(edge_a[:, 0] * edge_b[:, 1] - edge_a[:, 1] * edge_b[:, 0]).sum() / 2)
log("UV area coverage: " + str(round(uv_coverage * 100, 1)) + "%")
if uv_coverage < 0.2:
    raise RuntimeError("UV packing still uses less than 20% of the atlas")
original_uv.active_render = True
mesh.uv_layers.active = original_uv

# Export geometry with minimal materials, then restore the exact source materials.
log("Exporting geometry and preserving the original PBR material definitions")
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT / "Sponza.gltf"), export_format="GLTF_SEPARATE",
    use_selection=True, export_materials="VIEWPORT", export_texcoords=True,
    export_normals=True, export_tangents=True, export_animations=False,
)
source = json.loads((SOURCE / "Sponza.gltf").read_text())
exported = json.loads((OUTPUT / "Sponza.gltf").read_text())
material_indices = [int(material["name"].removeprefix("Material_")) for material in exported["materials"]]
for exported_mesh in exported["meshes"]:
    for primitive in exported_mesh["primitives"]:
        if "TEXCOORD_1" not in primitive["attributes"]:
            raise RuntimeError("The exported mesh is missing its baked UV set")
        primitive["material"] = material_indices[primitive["material"]]
for key in ("materials", "textures", "images", "samplers"):
    exported[key] = copy.deepcopy(source[key])
for image in exported["images"]:
    image["uri"] = "../" + image["uri"]
exported.pop("extensionsUsed", None)
exported.pop("extensionsRequired", None)
(OUTPUT / "Sponza.gltf").write_text(json.dumps(exported, separators=(",", ":")) + "\n")

scene.render.engine = "CYCLES"
preferences = bpy.context.preferences.addons["cycles"].preferences
preferences.compute_device_type = "HIP"
preferences.get_devices()
devices = [device for device in preferences.devices if device.type == "HIP"]
for device in preferences.devices:
    device.use = device.type == "HIP"
scene.cycles.device = "GPU" if devices else "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.seed = 23
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 4
scene.cycles.transparent_max_bounces = 16
scene.cycles.use_denoising = False
scene.render.bake.margin = 1
scene.render.bake.margin_type = "EXTEND"
scene.world = bpy.data.worlds.new("Black world for sun-bounce bake")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0
scene.world.light_settings.distance = AO_DISTANCE

sun_data = bpy.data.lights.new("Sun matching Babylon", type="SUN")
sun_data.energy = SUN_INTENSITY
sun_data.angle = 0.01
sun = bpy.data.objects.new("Sun matching Babylon", sun_data)
scene.collection.objects.link(sun)
# Babylon's left-handed Y-up world maps to Blender as (x, z, y).
sun.rotation_euler = Vector((SUN_DIRECTION[0], SUN_DIRECTION[2], SUN_DIRECTION[1])).to_track_quat("-Z", "Y").to_euler()

target = bpy.data.images.new("BakeTarget", width=SIZE, height=SIZE, alpha=True, float_buffer=True)
target.colorspace_settings.name = "Non-Color"
target.generated_color = (0, 0, 0, 0)
for material in mesh.materials:
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = target
    material.node_tree.nodes.active = node
    # Keep all source texture sampling on UV0 while baking into UV1.
    uv_node = material.node_tree.nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = original_uv.name
    for texture_node in material.node_tree.nodes:
        if texture_node.type == "TEX_IMAGE" and texture_node != node and not texture_node.inputs["Vector"].is_linked:
            material.node_tree.links.new(uv_node.outputs["UV"], texture_node.inputs["Vector"])
    for normal_node in material.node_tree.nodes:
        if normal_node.type == "NORMAL_MAP":
            normal_node.uv_map = original_uv.name

log("Baking AO on " + (devices[0].name if devices else "CPU"))
bpy.ops.object.bake(type="AO", uv_layer=bake_uv.name, use_clear=True)
ao = read_pixels(target)
coverage = ao[:, :, :3].max(axis=2) > 0
if not coverage.any():
    raise RuntimeError("AO bake has no covered pixels")
ao_rgb = np.clip(ao[:, :, :3], 0, 1)
png(OUTPUT / "ao.png", np.rint(ao_rgb * 255))

log("Baking diffuse INDIRECT + COLOR; direct sunlight is excluded")
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"INDIRECT", "COLOR"}, uv_layer=bake_uv.name, use_clear=True)
indirect = read_pixels(target)
sun_radiance = np.maximum(indirect[:, :, :3], 0)
log("Baking diffuse skylight DIRECT + INDIRECT + COLOR with the sun disabled")
sun_data.energy = 0
background = scene.world.node_tree.nodes["Background"]
background.inputs["Color"].default_value = (*SKY_COLOR, 1)
background.inputs["Strength"].default_value = SKY_STRENGTH
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"}, uv_layer=bake_uv.name, use_clear=True)
sky = read_pixels(target)
sky_radiance = np.maximum(sky[:, :, :3], 0)
if not sky_radiance.max() > 0:
    raise RuntimeError("Skylight bake contains no light")
radiance = sun_radiance + sky_radiance
peak = float(radiance.max())
if peak <= 0:
    raise RuntimeError("Indirect bake contains no light")
scale = float(2 ** max(0, math.ceil(math.log2(peak))))
# Match Babylon's default gamma-2.2 lightmap decode; level restores the HDR range.
png(OUTPUT / "indirect.png", np.rint(np.power(np.clip(radiance / scale, 0, 1), 1 / 2.2) * 255))
metadata = {
    "blender": bpy.app.version_string,
    "device": devices[0].name if devices else "CPU",
    "resolution": SIZE, "samples": SAMPLES, "diffuseBounces": 4,
    "aoDistance": AO_DISTANCE, "uvChannel": 1,
    "sun": {"direction": SUN_DIRECTION, "intensity": SUN_INTENSITY},
    "indirectPasses": ["INDIRECT", "COLOR"],
    "sky": {"model": "uniform world", "colorLinear": SKY_COLOR, "strength": SKY_STRENGTH,
            "passes": ["DIRECT", "INDIRECT", "COLOR"]},
    "includesDiffuseSky": True,
    "indirectEncoding": "gamma2.2 RGB8 with linear scale",
    "lightmapScale": scale,
    "sourceSha256": hashlib.sha256((SOURCE / "Sponza.gltf").read_bytes()).hexdigest(),
    "statistics": {
        "uvAreaCoverage": uv_coverage,
        "nonzeroAoTexels": int(coverage.sum()),
        "aoMean": float(ao_rgb[coverage].mean()),
        "aoMinimum": float(ao_rgb[coverage].min()),
        "indirectPeak": peak,
        "indirectMean": float(radiance[coverage].mean()),
        "sunIndirectMean": float(sun_radiance[coverage].mean()),
        "skyMean": float(sky_radiance[coverage].mean()),
    },
}
metadata["sha256"] = {name: hashlib.sha256((OUTPUT / name).read_bytes()).hexdigest() for name in ("Sponza.gltf", "Sponza.bin", "ao.png", "indirect.png")}
(OUTPUT / "lighting.json").write_text(json.dumps(metadata, indent=2) + "\n")
log("Complete: " + json.dumps(metadata["statistics"]))
