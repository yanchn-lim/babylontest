"""Offline lightmap filtering with isolated UV islands; never used at runtime."""
import ctypes as ct
import os
from pathlib import Path
import sys
import numpy as np


class LightmapDenoiser:
    def __init__(self, triangles, size, library):
        self.dll_directory = os.add_dll_directory(str(library))
        self.lib = ct.CDLL(str(library / 'OpenImageDenoise.dll'))
        pointer = ct.c_void_p
        def bind(name, result, *arguments):
            function = getattr(self.lib, name)
            function.restype = result
            function.argtypes = list(arguments)
            return function
        self.device = bind('oidnNewDevice', pointer, ct.c_int)(1)
        bind('oidnCommitDevice', None, pointer)(self.device)
        self.new = bind('oidnNewFilter', pointer, pointer, ct.c_char_p)
        self.set_image = bind('oidnSetSharedFilterImage', None, pointer, ct.c_char_p, pointer, ct.c_int, *([ct.c_size_t] * 5))
        self.set_float = bind('oidnSetFilterFloat', None, pointer, ct.c_char_p, ct.c_float)
        self.commit = bind('oidnCommitFilter', None, pointer)
        self.execute = bind('oidnExecuteFilter', None, pointer)
        self.release = bind('oidnReleaseFilter', None, pointer)
        self.error = bind('oidnGetDeviceError', ct.c_int, pointer, ct.POINTER(ct.c_char_p))
        parents = list(range(len(triangles)))
        def root(index):
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index
        vertices = {}
        for index, triangle in enumerate(triangles):
            for vertex in triangle:
                key = tuple(vertex)
                if key in vertices:
                    parents[root(index)] = root(vertices[key])
                vertices[key] = index
        groups = {}
        for index, triangle in enumerate(triangles):
            groups.setdefault(root(index), []).append(triangle)
        self.owners = np.zeros((size, size), np.int32)
        for label, group in enumerate(groups.values(), 1):
            for triangle in group:
                a, b, c = triangle * size
                low = np.maximum(0, np.floor(np.minimum.reduce([a, b, c])).astype(int))
                high = np.minimum(size, np.ceil(np.maximum.reduce([a, b, c])).astype(int))
                x0, y0 = low
                x1, y1 = high
                yy, xx = np.mgrid[y0:y1, x0:x1]
                x, y = xx + .5 - a[0], yy + .5 - a[1]
                b, c = b - a, c - a
                determinant = b[0] * c[1] - b[1] * c[0]
                if abs(determinant) < 1e-12:
                    continue
                u = (x * c[1] - y * c[0]) / determinant
                v = (b[0] * y - b[1] * x) / determinant
                mask = (u >= -1e-7) & (v >= -1e-7) & (u + v <= 1 + 1e-7)
                self.owners[y0:y1, x0:x1][mask] = label
        self.tiles = []
        for label in range(1, len(groups) + 1):
            ys, xs = np.where(self.owners == label)
            if not len(xs):
                continue
            region = np.s_[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            self.tiles.append((region, self.owners[region] == label))

    def filter(self, values):
        result = values.copy()
        def nearest(indices, count):
            positions = np.arange(count)
            right = np.minimum(np.searchsorted(indices, positions), len(indices) - 1)
            left = np.maximum(0, right - 1)
            return np.where(abs(indices[left] - positions) <= abs(indices[right] - positions), indices[left], indices[right])
        for region, mask in self.tiles:
            filled = values[region].copy()
            rows = np.flatnonzero(mask.any(axis=1))
            for row in rows:
                filled[row] = filled[row, nearest(np.flatnonzero(mask[row]), filled.shape[1])]
            filled = filled[nearest(rows, filled.shape[0])]
            color = np.ascontiguousarray(np.pad(filled, ((32, 32), (32, 32), (0, 0)), mode='edge'))
            output = np.empty_like(color)
            handle = self.new(self.device, b'RTLightmap')
            for name, array in [(b'color', color), (b'output', output)]:
                self.set_image(handle, name, array.ctypes.data, 3, array.shape[1], array.shape[0], 0, 0, 0)
            self.set_float(handle, b'inputScale', 1.0)
            self.commit(handle)
            self.execute(handle)
            message = ct.c_char_p()
            error = self.error(self.device, ct.byref(message))
            self.release(handle)
            if error:
                raise RuntimeError(message.value.decode())
            if not np.isfinite(output).all():
                raise RuntimeError('Lightmap denoising returned non-finite values')
            result[region][mask] = np.maximum(0, output[32:-32, 32:-32][mask])
        # Extend filtered borders into padding, without mixing separate islands.
        covered = self.owners != 0
        for _ in range(8):
            old_mask = np.pad(covered, 1)
            old_color = np.pad(result, ((1, 1), (1, 1), (0, 0)))
            h, w = covered.shape
            for dy, dx in [(0, 1), (2, 1), (1, 0), (1, 2)]:
                margin = ~covered & old_mask[dy:dy + h, dx:dx + w]
                result[margin] = old_color[dy:dy + h, dx:dx + w][margin]
                covered[margin] = True
        return result


if __name__ == '__main__':
    triangles = np.load(sys.argv[1])
    raw = np.load(sys.argv[2])
    library = Path(__file__).resolve().parents[1] / '.tools/oidn-2.3.3.x64.windows/bin'
    denoiser = LightmapDenoiser(triangles, raw.shape[0], library)
    np.save(sys.argv[3], denoiser.filter(raw))
