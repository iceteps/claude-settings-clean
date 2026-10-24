"""Minimal glTF 2.0 binary writer shared by the view builders.

Positions are passed in glTF space (metres, Y up). `from_step` converts STEP millimetres
(Z up) to that space: (x, z, -y) / 1000.
"""
import json
import os
import struct

import numpy as np


def from_step(pts_mm):
    p = np.asarray(pts_mm, dtype=np.float64) / 1000.0
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1).astype(np.float32)


def rgb(hexc):
    return tuple(int(hexc[k:k + 2], 16) for k in (0, 2, 4))


def colour_material(name, hexc, alpha=1.0):
    r, g, b = (c / 255 for c in rgb(hexc))
    mat = {"name": name, "doubleSided": True,
           "pbrMetallicRoughness": {"baseColorFactor": [r, g, b, alpha], "metallicFactor": 0.0,
                                    "roughnessFactor": 0.8}}
    if alpha < 1:
        mat["alphaMode"] = "BLEND"
    return mat


class Glb:
    def __init__(self):
        self.blob = bytearray()
        self.views, self.accessors, self.meshes, self.materials, self.nodes = [], [], [], [], []
        self.images, self.textures = [], []
        self._material_index = {}  # json of a material -> its index

    def _put(self, data, target=None):
        while len(self.blob) % 4:
            self.blob.append(0)
        view = {"buffer": 0, "byteOffset": len(self.blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.views.append(view)
        self.blob.extend(data)
        return len(self.views) - 1

    def mesh(self, name, pos, idx, mat, uv=None, extras=None):
        """Add one node with one mesh. Identical materials (same name AND same content) are
        written once and shared; a same-named material with different content (another colour,
        alpha or texture) is written separately, so it can never be merged by accident.
        `extras` (a flat dict of strings) is stored on the node for the web viewer."""
        pos = np.asarray(pos, dtype=np.float32)
        idx = np.asarray(idx, dtype=np.uint32).ravel()
        attrs = {"POSITION": len(self.accessors)}
        self.accessors.append({"bufferView": self._put(pos.tobytes(), 34962), "componentType": 5126,
                               "count": len(pos), "type": "VEC3",
                               "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
        if uv is not None:
            uv = np.asarray(uv, dtype=np.float32)
            attrs["TEXCOORD_0"] = len(self.accessors)
            self.accessors.append({"bufferView": self._put(uv.tobytes(), 34962), "componentType": 5126,
                                   "count": len(uv), "type": "VEC2"})
        self.accessors.append({"bufferView": self._put(idx.tobytes(), 34963), "componentType": 5125,
                               "count": len(idx), "type": "SCALAR"})
        key = json.dumps(mat, sort_keys=True)
        if key not in self._material_index:
            self.materials.append(json.loads(key))  # a copy: later edits to `mat` cannot drift
            self._material_index[key] = len(self.materials) - 1
        mat_index = self._material_index[key]
        self.meshes.append({"name": name, "primitives": [{"attributes": attrs,
                                                          "indices": len(self.accessors) - 1,
                                                          "material": mat_index}]})
        node = {"name": name, "mesh": len(self.meshes) - 1}
        if extras:
            node["extras"] = extras
        self.nodes.append(node)

    def image_quad(self, name, png, corners, extras=None):
        """A self-lit textured quad: black base colour plus the image as emissive, so it reads
        the same under any lighting. Corners run bottom-left, bottom-right, top-right, top-left."""
        self.images.append({"bufferView": self._put(png), "mimeType": "image/png"})
        self.textures.append({"source": len(self.images) - 1})
        mat = {"name": name, "doubleSided": True,
               "emissiveTexture": {"index": len(self.textures) - 1}, "emissiveFactor": [1, 1, 1],
               "pbrMetallicRoughness": {"baseColorFactor": [0, 0, 0, 1], "metallicFactor": 0.0,
                                        "roughnessFactor": 1.0}}
        uv = [[0, 1], [1, 1], [1, 0], [0, 0]]
        self.mesh(name, corners, [0, 1, 2, 0, 2, 3], mat, uv, extras)

    def write(self, path, generator, legend=None):
        """`legend`, when given, is stored as the scene's `extras.legend` for the web viewer's
        Legend dropdown: {"title": str, "entries": [{"label", "colour" (hex, no #), "alpha",
        "materials": [material names], optional "section"}], "notes": [str]}. Build it from the
        same table that draws the legend board, so the two cannot disagree."""
        scene = {"nodes": list(range(len(self.nodes)))}
        if legend:
            scene["extras"] = {"legend": legend}
        doc = {"asset": {"version": "2.0", "generator": generator}, "scene": 0,
               "scenes": [scene], "nodes": self.nodes,
               "meshes": self.meshes, "materials": self.materials, "accessors": self.accessors,
               "bufferViews": self.views, "buffers": [{"byteLength": len(self.blob)}]}
        if self.images:
            doc["images"], doc["textures"] = self.images, self.textures
        js = json.dumps(doc, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        blob = bytes(self.blob) + b"\0" * (-len(self.blob) % 4)
        tmp = path + ".tmp"
        with open(tmp, "wb") as out:
            out.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
            out.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
            out.write(struct.pack("<II", len(blob), 0x004E4942) + blob)
        os.replace(tmp, path)
