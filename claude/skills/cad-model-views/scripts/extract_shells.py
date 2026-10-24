# Run under freecadcmd. Paths come from env: STEP_SRC (STEP), OUT_DIR (output dir).
# Loads the model once (caching a native BREP for fast reloads), then writes:
#   shells.json  one record per shell: bbox, area, face count, face-type histogram
#   shells.obj   coarse mesh of every shell, one OBJ object per shell ("s<index>")
import json
import os
import time
from collections import Counter

import MeshPart
import Part

SRC = os.environ["STEP_SRC"]
OUT = os.environ["OUT_DIR"]
os.makedirs(OUT, exist_ok=True)
LOG = open(os.path.join(OUT, "extract.log"), "a", buffering=1)


def log(msg):
    LOG.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


brep = os.path.join(OUT, "model.brep")
shape = Part.Shape()
t0 = time.time()
if os.path.exists(brep):
    log("loading cached BREP")
    shape.read(brep)
else:
    log("reading STEP (slow)")
    shape.read(SRC)
    log(f"STEP read in {time.time() - t0:.0f}s; writing BREP cache")
    shape.exportBrep(brep + ".tmp")
    os.replace(brep + ".tmp", brep)
log(f"shape ready in {time.time() - t0:.0f}s")

shells = shape.Shells
log(f"{len(shells)} shells")
orphans = len(shape.Faces) - sum(len(s.Faces) for s in shells)
if orphans:
    log(f"WARNING: {orphans} faces belong to no shell (surface-only export?); they are not in shells.obj")

records = []
obj_tmp = os.path.join(OUT, "shells.obj.tmp")
with open(obj_tmp, "w") as obj:
    vbase = 1
    for i, s in enumerate(shells):
        bb = s.BoundBox
        kinds = Counter(type(f.Surface).__name__ for f in s.Faces)
        records.append({
            "i": i,
            "bbox": [round(v, 1) for v in (bb.XMin, bb.YMin, bb.ZMin, bb.XMax, bb.YMax, bb.ZMax)],
            "area": round(s.Area, 1),
            "faces": len(s.Faces),
            "closed": s.isClosed(),
            "kinds": dict(kinds),
        })
        mesh = MeshPart.meshFromShape(Shape=s, LinearDeflection=20.0, AngularDeflection=0.5)
        points, facets = mesh.Topology
        obj.write(f"o s{i}\n")
        for p in points:
            obj.write(f"v {p.x:.1f} {p.y:.1f} {p.z:.1f}\n")
        for a, b, c in facets:
            obj.write(f"f {a + vbase} {b + vbase} {c + vbase}\n")
        vbase += len(points)
        if i % 250 == 0:
            log(f"shell {i}/{len(shells)}")
os.replace(obj_tmp, os.path.join(OUT, "shells.obj"))

with open(os.path.join(OUT, "shells.json"), "w") as f:
    json.dump(records, f)
open(os.path.join(OUT, "DONE"), "w").write("ok\n")
log("DONE")
