"""Unwrap the couch's lighting UVs; keep the native material UVs unchanged."""
import bpy, json, math, sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
study = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'couch'
assert study in ('couch', 'applaryd')
data = json.loads((root / f'.tools/{study}-study/geometry.json').read_text())
vertices, faces, lookup = [], [], {}
for mesh in data:
    positions = mesh['positions']
    for i in range(0, len(positions), 9):
        face = []
        for j in range(3):
            point = tuple(positions[i + j * 3:i + j * 3 + 3])
            key = tuple(round(v, 7) for v in point)
            if key not in lookup:
                lookup[key] = len(vertices)
                vertices.append(point)
            face.append(lookup[key])
        faces.append(face)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
mesh = bpy.data.meshes.new('Couch lighting charts')
mesh.from_pydata(vertices, [], faces)
assert len(mesh.polygons) == len(faces)
obj = bpy.data.objects.new('Couch', mesh)
bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.025, scale_to_bounds=True)
bpy.ops.object.mode_set(mode='OBJECT')
uv = mesh.uv_layers.active.data
flat = [component for polygon in mesh.polygons for loop in polygon.loop_indices for component in uv[loop].uv]
atlas, start = [], 0
for source in data:
    count = len(source['positions']) // 3 * 2
    atlas.append([.48 + value * .50 if i % 2 == 0 else .02 + value * .96 for i, value in enumerate(flat[start:start + count])])
    start += count
(root / f'public/comparison/{study}/atlas.json').write_text(json.dumps(atlas, separators=(',', ':')))
print('Couch atlas:', len(faces), 'triangles')
