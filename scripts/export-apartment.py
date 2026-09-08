"""Export the supplied apartment without executing scripts stored in the .blend.
Run with Blender --background --disable-autoexec --python this script -- source.blend
"""
import hashlib
import json
from pathlib import Path
import sys
import bpy

source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output = Path(__file__).resolve().parents[1] / "public/models/bukit-merah"
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
for collection in bpy.data.collections:
    collection.hide_viewport = False
bpy.ops.object.select_all(action="DESELECT")
objects = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "FONT"} and not obj.hide_render]
for obj in objects:
    obj.hide_set(False)
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.convert(target="MESH")
bpy.ops.export_scene.gltf(
    filepath=str(output / "Apartment.glb"), export_format="GLB", use_selection=True,
    export_apply=True, export_cameras=False, export_lights=False, export_animations=False,
    export_extras=False,
)
metadata = {"sourceFile": source.name, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "blender": bpy.app.version_string, "exportedObjects": len(objects),
            "glbSha256": hashlib.sha256((output / "Apartment.glb").read_bytes()).hexdigest()}
(output / "asset.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
print("EXPORT: " + json.dumps(metadata))
