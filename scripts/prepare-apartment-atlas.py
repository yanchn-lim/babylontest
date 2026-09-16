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
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[item["type"]]
    fmt = {5126: "f", 5125: "I", 5123: "H"}[item["componentType"]]
    stride = view.get("byteStride", struct.calcsize(fmt) * components)
    offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
    return [struct.unpack_from("<" + fmt * components, buffers[view["buffer"]], offset + i * stride)
            for i in range(item["count"])]


# This model has one mesh and no node transforms. Fail if its structure changes.
assert len(model["meshes"]) == 1
assert all(not any(key in node for key in ("matrix", "translation", "rotation", "scale")) for node in model["nodes"])
bpy.ops.wm.read_factory_settings(use_empty=True)
groups, primitives = {}, []
for primitive in model["meshes"][0]["primitives"]:
    points = accessor(primitive["attributes"]["POSITION"])
    indices = [item[0] for item in accessor(primitive["indices"])]
    triangles = []
    transmitting = model["materials"][primitive["material"]].get("alphaMode") == "BLEND"
    for start in range(0, len(indices), 3):
        corners = [Vector(points[index]) for index in indices[start:start + 3]]
        if transmitting:
            triangles.append(None)
            continue
        normal = (corners[1] - corners[0]).cross(corners[2] - corners[0]).normalized()
        assert normal.length > 0.99
        key = (*[round(v, 4) for v in normal], round(normal.dot(corners[0]), 4))
        if key not in groups:
            u = (corners[1] - corners[0]).normalized()
            groups[key] = {"u": u, "v": normal.cross(u), "points": []}
        group = groups[key]
        projected = [(p.dot(group["u"]), p.dot(group["v"])) for p in corners]
        group["points"].extend(projected)
        triangles.append((key, projected))
    primitives.append(triangles)

# One rectangle per plane keeps coplanar wall sections continuous, including
# sections whose original triangles meet at a T-junction instead of shared edges.
vertices, faces = [], []
for group in groups.values():
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
for polygon, original, group in zip(mesh.polygons, faces, groups.values()):
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
        key, points = triangle
        group = groups[key]
        for point in points:
            u, v = [(point[k] - group["lo"][k]) / group["extent"][k] for k in (0, 1)]
            uv = group["origin"] + group["du"] * u + group["dv"] * v
            uvs.extend(round(float(value), 8) for value in uv)
    atlas.append(uvs)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(atlas, separators=(",", ":")) + "\n")
print(f"Prepared {len(groups)} planar charts, {area:.1%} chart coverage, two-pixel margin: {OUTPUT}")
