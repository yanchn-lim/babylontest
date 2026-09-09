"""Rebake the current apartment materials without changing geometry or UVs.
Run with Blender: --background --factory-startup --python-exit-code 1 --python scripts/rebake-apartment.py
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import zlib

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/bukit-merah/pbr"
OUTPUT = ROOT / ".tools/apartment-pbr-rebaked"
SIZE = 4096
SAMPLES = 1024
OUTPUT.mkdir(parents=True, exist_ok=True)
model = json.loads((SOURCE / "Apartment.gltf").read_text())
metadata = json.loads((SOURCE / "lighting.json").read_text())
assert metadata["ceilingIncluded"]
inputs = {"Apartment.gltf", *(item["uri"] for item in model["buffers"]), *(item["uri"] for item in model["images"])}
hashes = {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in sorted(inputs)}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE / "Apartment.gltf"))
objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
assert objects and all(len(obj.data.uv_layers) >= 2 for obj in objects)
bpy.ops.object.select_all(action="DESELECT")
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
mesh = obj.data
uv0, uv1 = mesh.uv_layers[:2]
uv0.active_render = True
mesh.uv_layers.active = uv0

scene = bpy.context.scene
scene.render.engine = "CYCLES"
preferences = bpy.context.preferences.addons["cycles"].preferences
preferences.compute_device_type = "HIP"
preferences.get_devices()
devices = [device for device in preferences.devices if device.type == "HIP"]
for device in preferences.devices:
    device.use = device.type == "HIP"
scene.cycles.device = "GPU" if devices else "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_adaptive_sampling = False
scene.cycles.seed = 23
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 4
scene.cycles.transparent_max_bounces = 16
scene.cycles.use_denoising = False
scene.render.bake.margin = 1
scene.render.bake.margin_type = "EXTEND"
scene.world = bpy.data.worlds.new("Diffuse skylight without sun")
scene.world.use_nodes = True
background = scene.world.node_tree.nodes["Background"]
background.inputs["Color"].default_value = (*metadata["sky"]["colorLinear"], 1)
background.inputs["Strength"].default_value = metadata["sky"]["strength"]
target = bpy.data.images.new("IndirectRebake", width=SIZE, height=SIZE, alpha=True, float_buffer=True)
target.colorspace_settings.name = "Non-Color"
target.generated_color = (0, 0, 0, 0)
for material in mesh.materials:
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = target
    material.node_tree.nodes.active = node
    uv_node = material.node_tree.nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = uv0.name
    for texture in material.node_tree.nodes:
        if texture.type == "TEX_IMAGE" and texture != node and not texture.inputs["Vector"].is_linked:
            material.node_tree.links.new(uv_node.outputs["UV"], texture.inputs["Vector"])
    for normal in material.node_tree.nodes:
        if normal.type == "NORMAL_MAP":
            normal.uv_map = uv0.name
            normal.inputs["Strength"].default_value = 0

print("REBAKE: Current materials, ceiling, existing UV1; 4096 pixels, 1024 samples", flush=True)
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"}, uv_layer=uv1.name, use_clear=True)
pixels = np.empty(SIZE * SIZE * 4, dtype=np.float32)
target.pixels.foreach_get(pixels)
radiance = np.maximum(pixels.reshape(SIZE, SIZE, 4)[:, :, :3], 0)
assert np.isfinite(radiance).all() and radiance.max() > 0
np.save(OUTPUT / "indirect-linear.npy", np.flipud(radiance))
scale = float(2 ** max(0, math.ceil(math.log2(float(radiance.max())))))
encoded = np.flipud(np.rint(np.clip(radiance / scale, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
rows = b"".join(b"\0" + row.tobytes() for row in encoded)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
(OUTPUT / "indirect.png").write_bytes(png + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))
metadata.pop("materialRetint", None)
metadata.pop("denoising", None)
metadata.pop("directional", None)
metadata["sha256"].pop("direction.png", None)
metadata.update(blender=bpy.app.version_string, device=devices[0].name if devices else "CPU",
                samples=SAMPLES, resolution=SIZE, lightmapScale=scale)
metadata["currentMaterialBake"] = {
    "inputs": hashes, "preservedUVChannel": 1, "seed": 23,
    "paintNormalDetail": "runtime only",
    "normalDetail": "runtime only",
    "linearIntermediate": {
        "file": "indirect-linear.npy", "encoding": "linear float32 RGB, PNG row order",
        "sha256": hashlib.sha256((OUTPUT / "indirect-linear.npy").read_bytes()).hexdigest(),
    },
}
metadata["statistics"]["indirectPeak"] = float(radiance.max())
metadata["statistics"]["indirectMean"] = float(radiance[radiance.max(axis=2) > 0].mean())
metadata["statistics"]["skyMean"] = metadata["statistics"]["indirectMean"]
metadata["sha256"]["indirect.png"] = hashlib.sha256((OUTPUT / "indirect.png").read_bytes()).hexdigest()
(OUTPUT / "lighting.json").write_text(json.dumps(metadata, indent=2) + "\n")
print("REBAKE COMPLETE: " + str(OUTPUT), flush=True)
