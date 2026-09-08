"""Build the apartment PBR variant from the existing denoised bake."""
import copy
import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/bukit-merah/baked"
OUTPUT = ROOT / "public/models/bukit-merah/pbr"
PROFILES = {
    0: ("smooth_concrete_floor", 2.0, [1, 1, 1], 0.35),
    1: ("interior_tiles", 1.9, [1, 1, 1], 0.45),
    2: ("interior_tiles", 1.9, [0.94, 0.97, 1], 0.45),
    3: ("smooth_concrete_floor", 2.0, [1, 1, 1], 0.35),
    4: ("white_plaster_02", 1.5, [1, 0.98, 0.95], 0.18),
    8: ("wood_table_001", 2.0, [1, 1, 1], 0.3),
    10: ("wood_table_001", 2.0, [0.75, 0.65, 0.55], 0.3),
    11: ("smooth_concrete_floor", 2.0, [1, 1, 1], 0.35),
}
OUTPUT.mkdir(parents=True, exist_ok=True)
(OUTPUT / "textures").mkdir(exist_ok=True)
source = json.loads((SOURCE / "Apartment.gltf").read_text())
model = copy.deepcopy(source)
lighting = json.loads((SOURCE / "lighting.json").read_text())
buffers = [(SOURCE / item["uri"]).read_bytes() for item in source["buffers"]]
for item in model["buffers"] + model["images"]:
    item["uri"] = "../baked/" + item["uri"]
assets = {}
downloads = {}
def download(url):
    return subprocess.check_output(
        ["curl.exe", "--fail", "--silent", "--show-error", "--location", url]
    )

for asset in sorted({profile[0] for profile in PROFILES.values()}):
    files = json.loads(download("https://api.polyhaven.com/files/" + asset))
    assets[asset] = {}
    for channel, key in [("color", "Diffuse"), ("normal", "nor_gl"), ("arm", "arm")]:
        info = files[key]["1k"]["jpg"]
        name = f"textures/{asset}-{channel}.jpg"
        path = OUTPUT / name
        data = path.read_bytes() if path.exists() else download(info["url"])
        assert hashlib.md5(data).hexdigest() == info["md5"], "Texture download checksum mismatch"
        path.write_bytes(data)
        downloads[name] = {"url": info["url"], "sha256": hashlib.sha256(data).hexdigest()}
        model["images"].append({"uri": name})
        model["textures"].append({"source": len(model["images"]) - 1, "sampler": 0})
        assets[asset][channel] = len(model["textures"]) - 1
    print("Downloaded", asset, flush=True)

def accessor(index):
    item = source["accessors"][index]
    view = source["bufferViews"][item["bufferView"]]
    dtype = np.dtype({5123: "<u2", 5125: "<u4", 5126: "<f4"}[item["componentType"]])
    columns = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[item["type"]]
    return np.ndarray((item["count"], columns), dtype, buffers[view["buffer"]],
        offset=view.get("byteOffset", 0) + item.get("byteOffset", 0),
        strides=(view.get("byteStride", columns * dtype.itemsize), dtype.itemsize))

def srgb(value):
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)

image_cache = {}
def sample(image_path, uv):
    if image_path not in image_cache:
        image_cache[image_path] = srgb(np.asarray(Image.open(image_path).convert("RGB"), dtype=np.float32) / 255)
    image = image_cache[image_path]
    h, w = image.shape[:2]
    position = (uv % 1) * [w, h] - 0.5
    base = np.floor(position).astype(int)
    blend = position - base
    x, y = base[:, 0] % w, base[:, 1] % h
    xx, yy = (x + 1) % w, (y + 1) % h
    top = image[y, x] * (1 - blend[:, :1]) + image[y, xx] * blend[:, :1]
    bottom = image[yy, x] * (1 - blend[:, :1]) + image[yy, xx] * blend[:, :1]
    return top * (1 - blend[:, 1:]) + bottom * blend[:, 1:]

pixels = np.asarray(Image.open(SOURCE / "indirect.png").convert("RGB"), dtype=np.float32) / 255
radiance = pixels ** 2.2 * lighting["lightmapScale"]
height, width = pixels.shape[:2]
covered = np.zeros((height, width), dtype=bool)
uv_buffer = bytearray()
uv_buffer_index = len(model["buffers"])
for mesh in model["meshes"]:
    for primitive in mesh["primitives"]:
        material_index = primitive["material"]
        indices = accessor(primitive["indices"]).ravel().reshape(-1, 3)
        light_uv = accessor(primitive["attributes"]["TEXCOORD_1"])
        profile = PROFILES.get(material_index)
        if profile:
            asset, repeat, tint, normal_strength = profile
            positions = accessor(primitive["attributes"]["POSITION"])
            normals = accessor(primitive["attributes"]["NORMAL"])
            axis = np.abs(normals).argmax(axis=1)
            uv = np.column_stack((
                np.where(axis == 0, positions[:, 2], positions[:, 0]),
                np.where(axis == 1, positions[:, 2], -positions[:, 1]),
            )).astype("<f4") / repeat
            old_uv = accessor(primitive["attributes"]["TEXCOORD_0"])
            old_pbr = source["materials"][material_index]["pbrMetallicRoughness"]
            old_factor = np.array(old_pbr.get("baseColorFactor", [1, 1, 1, 1])[:3])
            old_image = source["images"][source["textures"][old_pbr["baseColorTexture"]["index"]]["source"]]["uri"]
            offset = len(uv_buffer)
            uv_buffer.extend(uv.astype("<f4").tobytes())
            model["bufferViews"].append({"buffer": uv_buffer_index, "byteOffset": offset, "byteLength": uv.nbytes})
            model["accessors"].append({"bufferView": len(model["bufferViews"]) - 1,
                "componentType": 5126, "count": len(uv), "type": "VEC2"})
            primitive["attributes"]["TEXCOORD_0"] = len(model["accessors"]) - 1
            primitive["attributes"].pop("TANGENT", None)
            material = model["materials"][material_index]
            material["pbrMetallicRoughness"] = {
                "baseColorTexture": {"index": assets[asset]["color"]},
                "baseColorFactor": [*tint, 1], "metallicFactor": 0, "roughnessFactor": 1,
                "metallicRoughnessTexture": {"index": assets[asset]["arm"]},
            }
            material["normalTexture"] = {"index": assets[asset]["normal"], "scale": normal_strength}
        for triangle in indices:
            a, b, c = light_uv[triangle].astype(float) * [width, height]
            low = np.maximum(np.floor(np.minimum.reduce([a, b, c])).astype(int), 0)
            high = np.minimum(np.ceil(np.maximum.reduce([a, b, c])).astype(int), [width, height])
            x0, y0 = low
            x1, y1 = high
            yy, xx = np.mgrid[y0:y1, x0:x1]
            x, y = xx + 0.5 - a[0], yy + 0.5 - a[1]
            b, c = b - a, c - a
            determinant = b[0] * c[1] - b[1] * c[0]
            if abs(determinant) < 1e-12:
                continue
            u = (x * c[1] - y * c[0]) / determinant
            v = (b[0] * y - b[1] * x) / determinant
            mask = (u >= -1e-7) & (v >= -1e-7) & (u + v <= 1 + 1e-7)
            # Shared triangle edges must be retinted only once.
            mask &= ~covered[y0:y1, x0:x1]
            covered[y0:y1, x0:x1][mask] = True
            if not profile or not mask.any():
                continue
            weights = np.column_stack((1 - u[mask] - v[mask], u[mask], v[mask]))
            old_color = sample(SOURCE / old_image, weights @ old_uv[triangle]) * old_factor
            new_color = sample(OUTPUT / f"textures/{asset}-color.jpg", weights @ uv[triangle]) * tint
            radiance[y0:y1, x0:x1][mask] *= new_color / np.maximum(old_color, 0.04)

padded_mask = np.pad(covered, 1)
padded_color = np.pad(radiance, ((1, 1), (1, 1), (0, 0)))
for dy in range(3):
    for dx in range(3):
        margin = ~covered & padded_mask[dy:dy + height, dx:dx + width]
        radiance[margin] = padded_color[dy:dy + height, dx:dx + width][margin]
assert np.isfinite(radiance).all() and radiance.max() > 0
scale = float(2 ** max(0, math.ceil(math.log2(float(radiance.max())))))
encoded = np.rint(np.clip(radiance / scale, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)
Image.fromarray(encoded).save(OUTPUT / "indirect.png")
model["buffers"].append({"uri": "materials.bin", "byteLength": len(uv_buffer)})
(OUTPUT / "materials.bin").write_bytes(uv_buffer)
(OUTPUT / "Apartment.gltf").write_text(json.dumps(model, separators=(",", ":")) + "\n")
lighting["lightmapScale"] = scale
lighting["materialRetint"] = {
    "sourceLightmapSha256": hashlib.sha256((SOURCE / "indirect.png").read_bytes()).hexdigest(),
    "method": "Linear new-albedo / old-albedo ratio; original bounced-light colors retained",
}
lighting["sha256"] = {
    name: hashlib.sha256((OUTPUT / name).read_bytes()).hexdigest()
    for name in ["Apartment.gltf", "materials.bin", "indirect.png", "../baked/ao.png"]
}
lighting["sha256"].update({name: info["sha256"] for name, info in downloads.items()})
(OUTPUT / "lighting.json").write_text(json.dumps(lighting, indent=2) + "\n")
(OUTPUT / "sources.json").write_text(json.dumps({
    "license": "CC0-1.0", "provider": "Poly Haven",
    "assets": {asset: "https://polyhaven.com/a/" + asset for asset in assets},
    "downloads": downloads,
}, indent=2) + "\n")
print("PBR variant complete. Lightmap scale:", scale, flush=True)
