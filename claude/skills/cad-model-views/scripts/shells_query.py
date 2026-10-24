"""Query shells.json (from extract_shells.py) by position, size and face types.

usage: python3 -I shells_query.py SHELLS.json [filters] [--ids-out FILE]
  --box X0 Y0 Z0 X1 Y1 Z1   bbox fully inside this box (metres)
  --near X Y R               bbox centre within R metres of (X, Y) in plan
  --min-size M / --max-size M  largest bbox extent at least / at most M metres
  --faces N                  exact face count
  --kinds Plane,Cylinder     face types are a subset of these
  --tall                     taller (z) than wide (x and y)
  --ids FILE                 restrict to the ids listed in FILE
Prints one line per shell (id, bbox in metres, faces, kinds) sorted by distance or id.
Units: shells.json is millimetres; every argument and printout here is metres.
"""
import argparse
import json
import math


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("shells")
    ap.add_argument("--box", nargs=6, type=float)
    ap.add_argument("--near", nargs=3, type=float)
    ap.add_argument("--min-size", type=float)
    ap.add_argument("--max-size", type=float)
    ap.add_argument("--faces", type=int)
    ap.add_argument("--kinds")
    ap.add_argument("--tall", action="store_true")
    ap.add_argument("--ids")
    ap.add_argument("--ids-out")
    ap.add_argument("--limit", type=int, default=60)
    a = ap.parse_args()

    allowed = set(open(a.ids).read().split()) if a.ids else None
    kinds = set(a.kinds.split(",")) if a.kinds else None
    rows = []
    for r in json.load(open(a.shells)):
        if allowed is not None and str(r["i"]) not in allowed:
            continue
        b = [v / 1000 for v in r["bbox"]]
        ext = [b[3] - b[0], b[4] - b[1], b[5] - b[2]]
        if a.box and not (a.box[0] <= b[0] and a.box[1] <= b[1] and a.box[2] <= b[2]
                          and b[3] <= a.box[3] and b[4] <= a.box[4] and b[5] <= a.box[5]):
            continue
        dist = 0.0
        if a.near:
            dist = math.hypot((b[0] + b[3]) / 2 - a.near[0], (b[1] + b[4]) / 2 - a.near[1])
            if dist > a.near[2]:
                continue
        if a.min_size is not None and max(ext) < a.min_size:
            continue
        if a.max_size is not None and max(ext) > a.max_size:
            continue
        if a.faces is not None and r["faces"] != a.faces:
            continue
        if kinds is not None and not set(r["kinds"]) <= kinds:
            continue
        if a.tall and not ext[2] > max(ext[0], ext[1]):
            continue
        rows.append((dist, r["i"], b, r))
    rows.sort(key=lambda t: (t[0], t[1]))
    for dist, i, b, r in rows[:a.limit]:
        box = " ".join(f"{v:7.2f}" for v in b)
        near = f"  d={dist:.2f}" if a.near else ""
        print(f"{i:6d}  {box}  faces {r['faces']:5d}  {dict(r['kinds'])}{near}")
    print(f"{len(rows)} shells match" + (f" (showing {a.limit})" if len(rows) > a.limit else ""))
    if a.ids_out:
        open(a.ids_out, "w").write("\n".join(str(i) for _, i, _, _ in rows) + "\n")


if __name__ == "__main__":
    main()
