"""Create a padded 256px lighting atlas without changing the apartment model.
Run with Blender 4.5: blender -b -t 4 --python scripts/prepare-apartment-atlas.py
"""
import json
import math
from pathlib import Path
import struct

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/bukit-merah/pbr"
OUTPUT = ROOT / "public/apartment-transfer/atlas.json"
model = json.loads((SOURCE / "Apartment.gltf").read_text())
buffers = [(SOURCE / item["uri"]).read_bytes() for item in model["buffers"]]


def accessor(index):
    item = model["accessors"][index]
    view = model["bufferViews"][item["bufferView"]]
    components = {"SCALAR": 1, "VEC3": 3}[item["type"]]
    fmt = {5126: "f", 5125: "I", 5123: "H"}[item["componentType"]]
    stride = view.get("byteStride", struct.calcsize(fmt) * components)
    offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
    return [struct.unpack_from("<" + fmt * components, buffers[view["buffer"]], offset + i * stride)
            for i in range(item["count"])]


# This model has one mesh and no node transforms. Fail if its structure changes.
assert len(model["meshes"]) == 1
assert all(not any(key in node for key in ("matrix", "translation", "rotation", "scale")) for node in model["nodes"])
bpy.ops.wm.read_factory_settings(use_empty=True)
groups, primitives, blockers = {}, [], []
for primitive in model["meshes"][0]["primitives"]:
    points = accessor(primitive["attributes"]["POSITION"])
    normals = accessor(primitive["attributes"]["NORMAL"])
    indices = [item[0] for item in accessor(primitive["indices"])]
    triangles = []
    transmitting = model["materials"][primitive["material"]].get("alphaMode") == "BLEND"
    for start in range(0, len(indices), 3):
        corners = [Vector(points[index]) for index in indices[start:start + 3]]
        if transmitting:
            triangles.append(None)
            continue
        if (corners[1] - corners[0]).cross(corners[2] - corners[0]).length < 1e-10:
            # Skip triangles that collapse at the model's float32 precision.
            triangles.append(None)
            continue
        normal = Vector(normals[indices[start]]).normalized()
        key = (*[round(v, 4) for v in normal], round(normal.dot(corners[0]), 4))
        if key not in groups:
            u = (corners[1] - corners[0]).normalized()
            groups[key] = {"u": u, "v": normal.cross(u), "triangles": []}
        group = groups[key]
        projected = [(p.dot(group["u"]), p.dot(group["v"])) for p in corners]
        triangle = {"corners": corners, "points": projected}
        group["triangles"].append(triangle)
        triangles.append(triangle)
        bounds = [[min(p[k] for p in corners), max(p[k] for p in corners)] for k in range(3)]
        blockers.append((normal, normal.dot(corners[0]), corners, bounds))
    primitives.append(triangles)

def shared_edge(a, b):
    for i in range(3):
        p, q = a[i], a[(i + 1) % 3]
        direction = (q - p).normalized()
        for j in range(3):
            r, s = b[j], b[(j + 1) % 3]
            if max((r - p).cross(direction).length, (s - p).cross(direction).length) > 1e-5:
                continue
            lo = max(0, min((r - p).dot(direction), (s - p).dot(direction)))
            hi = min((q - p).length, max((r - p).dot(direction), (s - p).dot(direction)))
            if hi - lo > 1e-5:
                return p + direction * ((lo + hi) / 2)
    return None


def blocked(point, normal):
    # Check on the receiving side, not inside the wall thickness.
    point = point + normal * .008
    for other, distance, corners, bounds in blockers:
        if abs(normal.dot(other)) > .9999 or abs(other.dot(point) - distance) > 1e-5:
            continue
        if any(point[k] < lo - 1e-5 or point[k] > hi + 1e-5 for k, (lo, hi) in enumerate(bounds)):
            continue
        if all(other.dot((corners[(i + 1) % 3] - corners[i]).cross(point - corners[i])) >= -1e-6 for i in range(3)):
            return True
    return False


# Join coplanar triangles (including T-junctions), but never through a wall.
charts = []
for key, group in groups.items():
    triangles = group["triangles"]
    parents = list(range(len(triangles)))

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    normal = Vector(key[:3])
    for i, triangle in enumerate(triangles):
        for j in range(i):
            if root(i) == root(j):
                continue
            edge = shared_edge(triangle["corners"], triangles[j]["corners"])
            if edge is not None and not blocked(edge, normal):
                parents[root(i)] = root(j)
    patches = {}
    for i, triangle in enumerate(triangles):
        patch = patches.setdefault(root(i), {"points": []})
        patch["points"].extend(triangle["points"])
        triangle["chart"] = patch
    charts.extend(patches.values())

vertices, faces = [], []
for group in charts:
    lo = [min(p[k] for p in group["points"]) for k in (0, 1)]
    hi = [max(p[k] for p in group["points"]) for k in (0, 1)]
    group["lo"], group["extent"] = lo, [hi[k] - lo[k] for k in (0, 1)]
    width, height = group["extent"]
    first = len(vertices)
    vertices.extend([(0, 0, 0), (width, 0, 0), (width, height, 0), (0, height, 0)])
    faces.append(list(range(first, first + 4)))
mesh = bpy.data.meshes.new("Apartment lighting atlas")
mesh.from_pydata(vertices, [], faces)
obj = bpy.data.objects.new(mesh.name, mesh)
bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
mesh.uv_layers.new(name="DiffuseTransfer")
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=2 / 256, margin_method="FRACTION")
bpy.ops.object.mode_set(mode="OBJECT")
assert len(mesh.polygons) == len(faces)
area = 0
for polygon, original, group in zip(mesh.polygons, faces, charts):
    assert list(polygon.vertices) == original
    uv = [mesh.uv_layers.active.data[loop].uv.copy() for loop in polygon.loop_indices]
    group["origin"], group["du"], group["dv"] = uv[0], uv[1] - uv[0], uv[3] - uv[0]
    area += abs(group["du"].cross(group["dv"]))
assert area > 0.15, "Atlas padding leaves too little area for lighting samples"
atlas = []
for triangles in primitives:
    uvs = []
    for triangle in triangles:
        if triangle is None:
            uvs.extend([0] * 6)
            continue
        group = triangle["chart"]
        for point in triangle["points"]:
            u, v = [(point[k] - group["lo"][k]) / group["extent"][k] for k in (0, 1)]
            uv = group["origin"] + group["du"] * u + group["dv"] * v
            uvs.extend(round(float(value), 8) for value in uv)
    atlas.append(uvs)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(atlas, separators=(",", ":")) + "\n")
print(f"Prepared {len(charts)} separated charts, {area:.1%} chart coverage, two-pixel margin: {OUTPUT}")
