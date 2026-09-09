"""Bake dominant incoming-light moments from the current diffuse lightmap.
Run with Blender --background --factory-startup --python scripts/bake-directional-lightmap.py.
This final gather approximates diffuse bounce; it does not trace new sun bounce.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/bukit-merah/pbr"
LIGHTING = ROOT / ".tools/apartment-pbr-denoised" if "--rebaked" in sys.argv else SOURCE
OUTPUT = ROOT / ".tools/apartment-directional"
SAMPLES = 1024
SPACING = 0.2
SIZE = 4096


def accessor(model, buffers, index):
    item = model["accessors"][index]
    view = model["bufferViews"][item["bufferView"]]
    columns = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[item["type"]]
    dtype = np.dtype({5123: "<u2", 5125: "<u4", 5126: "<f4"}[item["componentType"]])
    return np.ndarray((item["count"], columns), dtype, buffers[view["buffer"]],
                      offset=view.get("byteOffset", 0) + item.get("byteOffset", 0),
                      strides=(view.get("byteStride", columns * dtype.itemsize), dtype.itemsize))


def resize(pixels, width, height):
    x = np.clip((np.arange(width) + 0.5) * pixels.shape[1] / width - 0.5, 0, pixels.shape[1] - 1)
    y = np.clip((np.arange(height) + 0.5) * pixels.shape[0] / height - 0.5, 0, pixels.shape[0] - 1)
    x0, y0 = x.astype(int), y.astype(int)
    x1, y1 = np.minimum(x0 + 1, pixels.shape[1] - 1), np.minimum(y0 + 1, pixels.shape[0] - 1)
    tx, ty = (x - x0)[None, :, None], (y - y0)[:, None, None]
    top = pixels[y0[:, None], x0] * (1 - tx) + pixels[y0[:, None], x1] * tx
    bottom = pixels[y1[:, None], x0] * (1 - tx) + pixels[y1[:, None], x1] * tx
    return top * (1 - ty) + bottom * ty


def fill_edges(pixels, mask):
    rows = np.flatnonzero(mask.any(axis=1))
    for y in rows:
        indices = np.flatnonzero(mask[y])
        x = np.arange(mask.shape[1])
        right = np.minimum(np.searchsorted(indices, x), len(indices) - 1)
        left = np.maximum(right - 1, 0)
        nearest = np.where(abs(indices[left] - x) <= abs(indices[right] - x), indices[left], indices[right])
        pixels[y] = pixels[y, nearest]
    for y in np.flatnonzero(~mask.any(axis=1)):
        pixels[y] = pixels[rows[np.argmin(abs(rows - y))]]


def png(path, pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    rows = b"".join(b"\0" + row.tobytes() for row in pixels)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
    path.write_bytes(data + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def main():
    metadata = json.loads((LIGHTING / "lighting.json").read_text())
    model = json.loads((SOURCE / "Apartment.gltf").read_text())
    assert metadata["currentMaterialBake"].get("normalDetail") == "runtime only", "Rebake without normal-map detail first"
    for name, expected in metadata["currentMaterialBake"]["inputs"].items():
        assert hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() == expected, "Stale bake input: " + name
    assert all(not any(key in node for key in ["matrix", "rotation", "scale", "translation", "skin"])
               for node in model["nodes"]), "Bake requires the current untransformed static model"
    assert hashlib.sha256((LIGHTING / "indirect.png").read_bytes()).hexdigest() == metadata["sha256"]["indirect.png"]
    buffers = [(SOURCE / item["uri"]).read_bytes() for item in model["buffers"]]
    positions, normals, uvs, opaque = [], [], [], []
    for mesh in model["meshes"]:
        for primitive in mesh["primitives"]:
            ids = accessor(model, buffers, primitive["indices"]).ravel().reshape(-1, 3)
            attrs = primitive["attributes"]
            positions.extend(accessor(model, buffers, attrs["POSITION"])[ids])
            normals.extend(accessor(model, buffers, attrs["NORMAL"])[ids])
            uvs.extend(accessor(model, buffers, attrs["TEXCOORD_1"])[ids])
            opaque.extend([model["materials"][primitive["material"]].get("alphaMode") != "BLEND"] * len(ids))
    positions, normals, uvs = map(np.asarray, (positions, normals, uvs))
    indices = np.flatnonzero(opaque)
    tree = BVHTree.FromPolygons(positions[indices].reshape(-1, 3).tolist(),
                               np.arange(len(indices) * 3).reshape(-1, 3).tolist(), all_triangles=True)
    image = bpy.data.images.load(str(LIGHTING / "indirect.png"), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    pixels = np.empty(SIZE * SIZE * 4, np.float32)
    image.pixels.foreach_get(pixels)
    light = np.flipud(pixels.reshape(SIZE, SIZE, 4)[..., :3]) ** 2.2 * metadata["lightmapScale"]
    sky = np.asarray(metadata["sky"]["colorLinear"]) * metadata["sky"]["strength"]
    edge1, edge2 = positions[:, 1] - positions[:, 0], positions[:, 2] - positions[:, 0]
    d11, d12, d22 = (edge1 * edge1).sum(1), (edge1 * edge2).sum(1), (edge2 * edge2).sum(1)
    determinant = d11 * d22 - d12 * d12
    parents = list(range(len(uvs)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    vertices = {}
    for i, triangle in enumerate(uvs):
        for uv in triangle:
            key = tuple(uv)
            if key in vertices:
                parents[root(i)] = root(vertices[key])
            vertices[key] = i
    groups = {}
    for i in range(len(uvs)):
        groups.setdefault(root(i), []).append(i)
    sample_z = (np.arange(SAMPLES) + 0.5) / SAMPLES
    angle = np.arange(SAMPLES) * (math.pi * (3 - math.sqrt(5)))
    local = np.stack((np.sqrt(1 - sample_z ** 2) * np.cos(angle),
                      np.sqrt(1 - sample_z ** 2) * np.sin(angle), sample_z), axis=1)
    direction_cache = {}
    def gather(point, normal):
        normal = normal / np.linalg.norm(normal)
        key = tuple(np.round(normal, 5))
        if key not in direction_cache:
            tangent = np.cross(normal, np.eye(3)[np.argmin(abs(normal))])
            tangent /= np.linalg.norm(tangent)
            directions = local @ np.stack((tangent, np.cross(normal, tangent), normal))
            direction_cache[key] = directions, [Vector(v) for v in directions]
        directions, vectors = direction_cache[key]
        origin = Vector(point + normal * 0.003)
        radiance = np.tile(sky, (SAMPLES, 1))
        hits, hit_points, samples = [], [], []
        for i, direction in enumerate(vectors):
            location, _, face, _ = tree.ray_cast(origin, direction, 100)
            if face is not None:
                hits.append(indices[face]); hit_points.append(tuple(location)); samples.append(i)
        if hits:
            hits = np.asarray(hits)
            offset = np.asarray(hit_points) - positions[hits, 0]
            a, b = (offset * edge1[hits]).sum(1), (offset * edge2[hits]).sum(1)
            u = (a * d22[hits] - b * d12[hits]) / np.maximum(determinant[hits], 1e-15)
            v = (b * d11[hits] - a * d12[hits]) / np.maximum(determinant[hits], 1e-15)
            uv = uvs[hits, 0] + u[:, None] * (uvs[hits, 1] - uvs[hits, 0]) + v[:, None] * (uvs[hits, 2] - uvs[hits, 0])
            xy = np.clip(uv * SIZE - 0.5, 0, SIZE - 1)
            lo = xy.astype(int); hi = np.minimum(lo + 1, SIZE - 1); t = xy - lo
            top = light[lo[:, 1], lo[:, 0]] * (1 - t[:, :1]) + light[lo[:, 1], hi[:, 0]] * t[:, :1]
            bottom = light[hi[:, 1], lo[:, 0]] * (1 - t[:, :1]) + light[hi[:, 1], hi[:, 0]] * t[:, :1]
            radiance[samples] = top * (1 - t[:, 1:]) + bottom * t[:, 1:]
        weights = radiance @ np.array([0.2126, 0.7152, 0.0722])
        return weights @ directions / max(float(weights.sum()), 1e-8)

    moments = np.zeros((SIZE, SIZE, 3), np.float32)
    covered = np.zeros((SIZE, SIZE), bool)
    probes = 0
    for number, group in enumerate(groups.values(), 1):
        uv = uvs[group] * SIZE
        low = np.maximum(np.floor(uv.min(axis=(0, 1))).astype(int), 0)
        high = np.minimum(np.ceil(uv.max(axis=(0, 1))).astype(int), SIZE)
        width, height = high - low
        if width < 1 or height < 1:
            continue
        area = np.linalg.norm(np.cross(edge1[group], edge2[group]), axis=1).sum() / 2
        uv_area = abs(np.cross(uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0])).sum() / 2
        step = max(1, math.sqrt(uv_area / max(area, 1e-8)) * SPACING)
        w, h = max(2, math.ceil(width / step)), max(2, math.ceil(height / step))
        grid = np.zeros((h, w, 3), np.float32)
        valid = np.zeros((h, w), bool)
        yy, xx = np.mgrid[:h, :w]
        coords = np.stack((low[0] + (xx + 0.5) * width / w, low[1] + (yy + 0.5) * height / h), -1)
        full_y, full_x = np.mgrid[low[1]:high[1], low[0]:high[0]]
        full_coords = np.stack((full_x + 0.5, full_y + 0.5), -1)
        full_mask = np.zeros((height, width), bool)
        for index, triangle in zip(group, uv):
            a, b, c = triangle
            matrix = np.stack((b - a, c - a), axis=1)
            if abs(np.linalg.det(matrix)) < 1e-10:
                continue
            inverse = np.linalg.inv(matrix)
            bary = (coords - a) @ inverse.T
            mask = (bary[..., 0] >= 0) & (bary[..., 1] >= 0) & (bary.sum(2) <= 1) & ~valid
            for y, x in zip(*np.where(mask)):
                u, v = bary[y, x]
                weights = np.array([1 - u - v, u, v])
                grid[y, x] = gather(weights @ positions[index], weights @ normals[index])
                probes += 1
            valid |= mask
            bary_full = (full_coords - a) @ inverse.T
            full_mask |= (bary_full[..., 0] >= -1e-7) & (bary_full[..., 1] >= -1e-7) & (bary_full.sum(2) <= 1 + 1e-7)
        if not valid.any():
            index = group[0]
            grid[:] = gather(positions[index].mean(0), normals[index].mean(0)); probes += 1
        else:
            fill_edges(grid, valid)
        tile = moments[low[1]:high[1], low[0]:high[0]]
        tile[full_mask] = resize(grid, width, height)[full_mask]
        covered[low[1]:high[1], low[0]:high[0]] |= full_mask
        if number % 50 == 0:
            print(f"Directional gather {number}/{len(groups)} islands, {probes} probes", flush=True)
    padded_mask = np.pad(covered, 1)
    padded = np.pad(moments, ((1, 1), (1, 1), (0, 0)))
    for y in range(3):
        for x in range(3):
            rim = ~covered & padded_mask[y:y + SIZE, x:x + SIZE]
            moments[rim] = padded[y:y + SIZE, x:x + SIZE][rim]
    assert np.isfinite(moments).all() and np.max(np.linalg.norm(moments, axis=2)) <= 1.001
    OUTPUT.mkdir(parents=True, exist_ok=True)
    png(OUTPUT / "direction.png", np.rint(np.clip(moments * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8))
    metadata["directional"] = {
        "version": 1, "file": "direction.png", "encoding": "RGB8 signed mean incoming direction",
        "space": "glTF model", "method": "uniform hemisphere final gather from baked diffuse radiance and sky",
        "samples": SAMPLES, "probeSpacingMetres": SPACING, "probes": probes,
        "resolution": SIZE, "referenceLightmapSha256": metadata["sha256"]["indirect.png"],
        "transparentSurfaces": "straight-through, no tint or refraction", "includesSunBounce": False,
    }
    metadata["sha256"]["direction.png"] = hashlib.sha256((OUTPUT / "direction.png").read_bytes()).hexdigest()
    (OUTPUT / "lighting.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("DIRECTIONAL BAKE COMPLETE", flush=True)


if __name__ == "__main__":
    main()
