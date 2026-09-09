"""Denoise the apartment lightmap using Open Image Denoise 2.3.3."""
import ctypes as ct
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PBR_REBAKE = "--pbr-rebake" in sys.argv
SOURCE = ROOT / ("public/models/bukit-merah/pbr" if PBR_REBAKE else "public/models/bukit-merah/baked")
INPUT = ROOT / ".tools/apartment-pbr-rebaked" if PBR_REBAKE else SOURCE
OUTPUT = ROOT / (".tools/apartment-pbr-denoised" if PBR_REBAKE else ".tools/apartment-denoised")
model = json.loads((SOURCE / "Apartment.gltf").read_text())
metadata = json.loads((INPUT / "lighting.json").read_text())
assert "denoising" not in metadata, "Start from the original bake, not a denoised image."
buffers = [(SOURCE / item["uri"]).read_bytes() for item in model["buffers"]]
original = np.asarray(Image.open(INPUT / "indirect.png").convert("RGB"))
height, width = original.shape[:2]
linear = (original.astype(np.float32) / 255) ** 2.2 * metadata["lightmapScale"]

def accessor(index):
    item = model["accessors"][index]
    view = model["bufferViews"][item["bufferView"]]
    dtype = np.dtype({5123: "<u2", 5125: "<u4", 5126: "<f4"}[item["componentType"]])
    columns = {"SCALAR": 1, "VEC2": 2}[item["type"]]
    return np.ndarray(
        (item["count"], columns), dtype, buffers[view["buffer"]],
        offset=view.get("byteOffset", 0) + item.get("byteOffset", 0),
        strides=(view.get("byteStride", columns * dtype.itemsize), dtype.itemsize),
    )

triangles = []
for mesh in model["meshes"]:
    for primitive in mesh["primitives"]:
        uv = accessor(primitive["attributes"]["TEXCOORD_1"])
        triangles.extend(uv[accessor(primitive["indices"]).ravel().reshape(-1, 3)])
parents = list(range(len(triangles)))

def root(index):
    while parents[index] != index:
        parents[index] = parents[parents[index]]
        index = parents[index]
    return index

vertices = {}
for index, triangle in enumerate(triangles):
    for point in triangle:
        key = tuple(point)
        if key in vertices:
            parents[root(index)] = root(vertices[key])
        vertices[key] = index

groups = {}
for index, triangle in enumerate(triangles):
    groups.setdefault(root(index), []).append(triangle)

owners = np.zeros((height, width), dtype=np.int32)
for label, group in enumerate(groups.values(), 1):
    for triangle in group:
        a, b, c = np.asarray(triangle, dtype=float) * [width, height]
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
        tile = owners[y0:y1, x0:x1]
        assert not np.any(mask & (tile != 0) & (tile != label)), "Overlapping UV islands"
        tile[mask] = label

library = ROOT / ".tools/oidn-2.3.3.x64.windows/bin"
os.environ["PATH"] = str(library) + os.pathsep + os.environ["PATH"]
dll_directory = os.add_dll_directory(str(library))
oidn = ct.CDLL(str(library / "OpenImageDenoise.dll"))

def bind(name, result, *arguments):
    function = getattr(oidn, name)
    function.restype = result
    function.argtypes = list(arguments)
    return function

pointer, size = ct.c_void_p, ct.c_size_t
device = bind("oidnNewDevice", pointer, ct.c_int)(1)
bind("oidnCommitDevice", None, pointer)(device)
get_error = bind("oidnGetDeviceError", ct.c_int, pointer, ct.POINTER(ct.c_char_p))
new_filter = bind("oidnNewFilter", pointer, pointer, ct.c_char_p)
set_image = bind("oidnSetSharedFilterImage", None, pointer, ct.c_char_p,
                 pointer, ct.c_int, size, size, size, size, size)
set_scale = bind("oidnSetFilterFloat", None, pointer, ct.c_char_p, ct.c_float)
commit = bind("oidnCommitFilter", None, pointer)
execute = bind("oidnExecuteFilter", None, pointer)
release = bind("oidnReleaseFilter", None, pointer)

def check():
    message = ct.c_char_p()
    if get_error(device, ct.byref(message)):
        raise RuntimeError(message.value.decode())

def nearest(indices, count):
    positions = np.arange(count)
    right = np.minimum(np.searchsorted(indices, positions), len(indices) - 1)
    left = np.maximum(right - 1, 0)
    return np.where(abs(indices[left] - positions) <= abs(indices[right] - positions),
                    indices[left], indices[right])

check()
result = linear.copy()
for label in range(1, len(groups) + 1):
    ys, xs = np.where(owners == label)
    if not len(xs):
        continue
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    mask = owners[y0:y1, x0:x1] == label
    filled = linear[y0:y1, x0:x1].copy()
    rows = np.flatnonzero(mask.any(axis=1))
    for row in rows:
        filled[row] = filled[row, nearest(np.flatnonzero(mask[row]), filled.shape[1])]
    filled = filled[nearest(rows, filled.shape[0])]
    color = np.ascontiguousarray(np.pad(filled, ((32, 32), (32, 32), (0, 0)), mode="edge"))
    output = np.empty_like(color)
    filter_handle = new_filter(device, b"RTLightmap")
    for name, array in [(b"color", color), (b"output", output)]:
        set_image(filter_handle, name, array.ctypes.data, 3,
                  array.shape[1], array.shape[0], 0, 0, 0)
    set_scale(filter_handle, b"inputScale", 1.0)
    commit(filter_handle)
    execute(filter_handle)
    check()
    release(filter_handle)
    assert np.isfinite(output).all(), "Denoiser returned invalid pixels"
    result[y0:y1, x0:x1][mask] = np.maximum(output[32:-32, 32:-32][mask], 0)
    if label % 50 == 0:
        print(f"Denoised {label}/{len(groups)} UV islands", flush=True)

bind("oidnReleaseDevice", None, pointer)(device)
covered = owners != 0
padded_mask = np.pad(covered, 1)
padded_color = np.pad(result, ((1, 1), (1, 1), (0, 0)))
for dy in range(3):
    for dx in range(3):
        margin = ~covered & padded_mask[dy:dy + height, dx:dx + width]
        result[margin] = padded_color[dy:dy + height, dx:dx + width][margin]

encoded = np.rint(np.clip(result / metadata["lightmapScale"], 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)
OUTPUT.mkdir(parents=True, exist_ok=True)
Image.fromarray(encoded).save(OUTPUT / "indirect.png")
metadata["denoising"] = {
    "filter": "Open Image Denoise RTLightmap",
    "colorSpace": "linear",
    "uvIslands": len(groups),
    "paddingPixels": 32,
    "inputSha256": metadata["sha256"]["indirect.png"],
}
metadata["sha256"]["indirect.png"] = hashlib.sha256((OUTPUT / "indirect.png").read_bytes()).hexdigest()
(OUTPUT / "lighting.json").write_text(json.dumps(metadata, indent=2) + "\n")
print("Denoising complete:", OUTPUT, flush=True)
