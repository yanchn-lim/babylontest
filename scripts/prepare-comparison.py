"""Run with Blender: blender -b --python scripts/prepare-comparison.py.

Creates the comparison geometry, lighting bases and matched Cycles references.
No apartment assets are read or changed.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import time
import zlib

import bpy
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'comparison'
WORK = ROOT / '.tools' / 'comparison'
SIZE = 512
SAMPLES = int(os.environ.get('COMPARISON_SAMPLES', '1024'))
HOURS = [6, 9, 12, 15, 18]
SKY = [0.48, 0.65, 1.0]
VIEWS = {
    'room': {'position': [2.35, -2.45, 1.6], 'target': [-0.4, 1.0, 1.25]},
    'doorway': {'position': [-1.9, -1.85, 1.6], 'target': [3.5, 0.1, 1.1]},
}


def convert(v):
    return [v[0], v[2], -v[1]]


def png(path, rgb):
    data = np.asarray(rgb, dtype=np.uint8)
    h, w, channels = data.shape
    def chunk(kind, payload):
        return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', w, h, 8, 6 if channels == 4 else 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(b'\0' + row.tobytes() for row in data))) + chunk(b'IEND', b''))


def display(path, linear):
    # Same ACES fit and exact sRGB transfer as the pinned Babylon renderer.
    value = np.maximum(0, linear) / 0.6
    value = value @ np.array([[.59719, .076, .0284], [.35458, .90834, .13383], [.04823, .01566, .83777]])
    value = (value * (value + .0245786) - .000090537) / (value * (.983729 * value + .432951) + .238081)
    value = value @ np.array([[1.60475, -.10208, -.00327], [-.53108, 1.10813, -.07276], [-.07367, -.00605, 1.07602]])
    value = np.clip(value, 0, 1)
    value = np.where(value <= .0031308, value * 12.92, 1.055 * value ** (1 / 2.4) - .055)
    png(path, np.uint8(value[::-1] * 255 + .5))


def pixels(image):
    data = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(data)
    return data.reshape(image.size[1], image.size[0], 4)


def lighting(hour):
    phase = (hour - 6) / 12 * math.pi
    elevation = max(0, math.sin(phase))
    direction = Vector((math.cos(phase) * .8, .65, elevation)).normalized()
    sun = 3.0 * min(1, elevation * 4) if 6 < hour < 18 else 0
    sky = .015 + .55 * elevation if 6 <= hour <= 18 else .015
    warm = min(1, elevation * 2)
    return {'direction': convert(direction), 'sun': sun, 'color': [1, .65 + .3 * warm, .38 + .52 * warm], 'sky': sky}


def material(name, color, roughness):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['IOR'].default_value = 1.5
    return result


def box(name, location, scale, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def main():
    start = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    # Small lightmap texels need more samples than the denoised camera images.
    scene.cycles.samples = SAMPLES * 4
    scene.cycles.seed = 731
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.adaptive_threshold = .02
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 8
    scene.cycles.glossy_bounces = 8
    prefs = bpy.context.preferences.addons['cycles'].preferences
    device = 'CPU'
    for backend in ['OPTIX', 'HIP', 'CUDA']:
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            available = [d for d in prefs.devices if d.type == backend]
            if available:
                for d in prefs.devices:
                    d.use = d.type == backend
                scene.cycles.device = 'GPU'
                device = backend
                break
        except (TypeError, RuntimeError):
            continue
    print('COMPARISON_DEVICE ' + device, flush=True)
    scene.view_settings.view_transform = 'Raw'
    scene.render.image_settings.file_format = 'OPEN_EXR'
    scene.render.image_settings.color_depth = '32'
    scene.render.resolution_x = 640
    scene.render.resolution_y = 480
    scene.render.resolution_percentage = 100
    wall = material('Warm plaster', [.65, .62, .56], .85)
    floor = material('Pale stone', [.38, .34, .28], .65)
    red = material('Terracotta', [.55, .075, .035], .8)
    white = material('Ivory ceramic', [.72, .72, .68], .26)
    dark = material('Charcoal', [.065, .075, .085], .45)
    box('Floor', [1, 0, -.10], [8.2, 6.2, .2], floor)
    box('Ceiling', [1, 0, 3.10], [8.2, 6.2, .2], wall)
    box('Left wall', [-3.10, 0, 1.5], [.2, 6.2, 3], wall)
    box('Back wall', [1, -3.10, 1.5], [8.2, .2, 3], wall)
    # Front wall surrounds an unglazed 2.4 x 1.8 metre opening.
    box('Window left', [-2.15, 3.10, 1.5], [1.9, .2, 3], wall)
    box('Window right', [2.15, 3.10, 1.5], [1.9, .2, 3], wall)
    box('Window sill', [0, 3.10, .45], [2.4, .2, .9], wall)
    box('Window header', [0, 3.10, 2.85], [2.4, .2, .3], wall)
    box('Partition rear', [3.10, -1.95, 1.5], [.2, 2.1, 3], wall)
    box('Partition front', [3.10, 1.9, 1.5], [.2, 2.2, 3], wall)
    box('Door header', [3.10, -.05, 2.65], [.2, 1.7, .7], wall)
    box('Side room outer', [5.10, 0, 1.5], [.2, 6.2, 3], wall)
    box('Side room front', [4.1, 3.10, 1.5], [2.2, .2, 3], wall)
    box('Colour block', [-1.9, 1.0, .6], [.8, .8, 1.2], red)
    box('Low plinth', [.35, .65, .30], [1.1, 1.1, .6], wall)
    box('Dark block', [1.6, 1.65, .4], [.65, .65, .8], dark)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=.4, location=[.35, .65, 1.0])
    bpy.context.object.data.materials.append(white)
    for p in bpy.context.object.data.polygons:
        p.use_smooth = True
    bpy.ops.object.select_all(action='SELECT')
    bpy.context.view_layer.objects.active = bpy.context.object
    bpy.ops.object.join()
    obj = bpy.context.object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.018)
    bpy.ops.object.mode_set(mode='OBJECT')
    mesh = obj.data
    mesh.calc_loop_triangles()
    np.save(WORK / 'uv-triangles.npy', np.array([[mesh.uv_layers.active.data[i].uv[:] for i in t.loops] for t in mesh.loop_triangles]))
    meshes = []
    materials = []
    for index, mat in enumerate(mesh.materials):
        shader = mat.node_tree.nodes.get('Principled BSDF')
        materials.append({'name': mat.name, 'color': list(shader.inputs['Base Color'].default_value)[:3], 'roughness': shader.inputs['Roughness'].default_value})
        part = {'material': index, 'positions': [], 'normals': [], 'uvs': [], 'indices': []}
        for triangle in mesh.loop_triangles:
            if triangle.material_index != index:
                continue
            for loop in triangle.loops:
                part['indices'].append(len(part['indices']))
                part['positions'].extend(convert(mesh.vertices[mesh.loops[loop].vertex_index].co))
                part['normals'].extend(convert(mesh.corner_normals[loop].vector))
                part['uvs'].extend(mesh.uv_layers.active.data[loop].uv)
        if part['indices']:
            meshes.append(part)
    world = bpy.data.worlds.new('Uniform sky')
    world.use_nodes = True
    scene.world = world
    background = world.node_tree.nodes.get('Background')
    background.inputs['Color'].default_value = (*SKY, 1)
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.angle = 0
    sun_obj = bpy.data.objects.new('Sun', sun)
    scene.collection.objects.link(sun_obj)
    fixtures = []
    for position in [[0, -.7, 2.65], [4, .6, 2.65]]:
        lamp = bpy.data.lights.new('Ceiling light', 'POINT')
        lamp.energy = 0
        lamp.color = [1, .72, .45]
        lamp.shadow_soft_size = 0
        lamp_obj = bpy.data.objects.new(lamp.name, lamp)
        scene.collection.objects.link(lamp_obj)
        lamp_obj.location = position
        fixtures.append(lamp)
    def set_lighting(hour, on):
        light = lighting(hour)
        direction = light['direction']
        sun_obj.rotation_euler = Vector([-direction[0], direction[2], -direction[1]]).to_track_quat('-Z', 'Y').to_euler()
        sun.energy = light['sun']
        sun.color = light['color']
        background.inputs['Strength'].default_value = light['sky']
        for lamp in fixtures:
            lamp.energy = 90 if on else 0
    image = bpy.data.images.new('Lighting basis', SIZE, SIZE, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    for mat in mesh.materials:
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        mat.node_tree.nodes.active = node
    scene.render.bake.margin = 8
    bases = []
    def bake(name, direct):
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR', 'INDIRECT', 'DIRECT'} if direct else {'COLOR', 'INDIRECT'})
        raw = np.maximum(0, pixels(image)[:, :, :3])
        np.save(WORK / (name + '-raw.npy'), raw)
        values = raw
        if raw.max() > 0:
            # A separate process avoids collisions with Blender's bundled OIDN DLLs.
            python = Path(bpy.app.binary_path).parent / '4.5/python/bin/python.exe'
            filtered = WORK / (name + '-filtered.npy')
            subprocess.run([str(python), str(ROOT / 'scripts/comparison_denoise.py'),
                            str(WORK / 'uv-triangles.npy'), str(WORK / (name + '-raw.npy')),
                            str(filtered)], check=True)
            values = np.load(filtered)
        maximum = float(values.max())
        multiplier = np.maximum(1, np.ceil(values.max(axis=2) / 16 * 255)).clip(1, 255).astype(np.uint8)
        rgb = np.clip(values / (multiplier[:, :, None] / 255 * 16), 0, 1)
        packed = np.dstack((np.uint8(rgb * 255 + .5), multiplier))
        png(OUT / (name + '.png'), packed[::-1])
        bases.append({'name': name, 'maximum': maximum, 'clipped': bool(maximum > 16)})
        if maximum > 16:
            raise RuntimeError('RGBM range exceeded: ' + name)
        print('COMPARISON_BAKED ' + name, flush=True)
    sun.energy = 0
    background.inputs['Strength'].default_value = 1
    bake('sky', True)
    background.inputs['Strength'].default_value = 0
    for lamp in fixtures:
        lamp.energy = 90
    bake('fixtures', False)
    for lamp in fixtures:
        lamp.energy = 0
    for hour in HOURS:
        set_lighting(hour, False)
        background.inputs['Strength'].default_value = 0
        bake('sun-' + str(hour), False)
    camera_data = bpy.data.cameras.new('Reference')
    camera = bpy.data.objects.new('Reference', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.sensor_fit = 'VERTICAL'
    camera_data.lens = camera_data.sensor_height / (2 * math.tan(.85 / 2))
    camera_data.clip_start = .05
    scene.cycles.samples = SAMPLES
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = True
    references = []
    for view_name, view in VIEWS.items():
        camera.location = view['position']
        camera.rotation_euler = (Vector(view['target']) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        for hour, on in [(9, False), (12, False), (15, False), (21, True), (12, True), (21, False)]:
            set_lighting(hour, on)
            key = f'{view_name}-{hour}-' + ('on' if on else 'off')
            scene.render.filepath = str(WORK / (key + '.exr'))
            bpy.ops.render.render(write_still=True)
            rendered = bpy.data.images.load(scene.render.filepath, check_existing=False)
            display(OUT / (key + '.png'), pixels(rendered)[:, :, :3])
            bpy.data.images.remove(rendered)
            references.append({'view': view_name, 'hour': hour, 'on': on, 'file': key + '.png'})
            print('COMPARISON_REFERENCE ' + key, flush=True)
    data = {'version': 1, 'materials': materials, 'meshes': meshes, 'sky': SKY, 'sunHours': HOURS,
            'views': {name: {'position': convert(v['position']), 'target': convert(v['target']), 'fov': .85} for name, v in VIEWS.items()},
            'fixtures': [{'position': convert(p), 'color': [1, .72, .45], 'intensity': 90 / (4 * math.pi)} for p in [[0, -.7, 2.65], [4, .6, 2.65]]],
            'references': references, 'atlasSize': SIZE, 'rgbmRange': 16}
    (OUT / 'scene.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    report = {'blender': bpy.app.version_string, 'device': device, 'samples': SAMPLES,
              'bakeSamples': SAMPLES * 4, 'bakeAdaptiveSampling': False, 'seed': 731,
              'denoising': {'references': 'Cycles offline denoising', 'bases': 'OIDN RTLightmap per UV island', 'runtime': False},
              'bounces': 8, 'atlasSize': SIZE, 'bases': bases,
              'referenceCount': len(references), 'seconds': time.time() - start,
              'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'files': {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in OUT.iterdir() if p.name != 'report.json'}}
    (OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('COMPARISON_COMPLETE ' + json.dumps({k: report[k] for k in ['device', 'samples', 'seconds', 'referenceCount']}), flush=True)


if __name__ == '__main__':
    main()
