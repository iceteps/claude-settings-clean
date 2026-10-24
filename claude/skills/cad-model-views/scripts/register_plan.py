"""Register a 2D drawing (site plan, layout render) onto model plan coordinates.

usage: python3 -I register_plan.py PAIRS.json OUT.json

PAIRS.json:
  {"source": "what the image is, how it was rendered (pdftoppm -r 200 ...)",
   "pairs":   [[px, py, mx, my], ...],   # image pixels (y down) -> model metres; 3 or more
   "markers": {"NAME": [px, py], ...},   # image points to map into the model
   "max_residual_m": 0.3}                # optional: fail above this (default 0.5)

Fits a least-squares similarity transform (scale, rotation, translation; the image's
downward y is flipped first, so a true top view needs no mirror). Writes the mapped
markers, the scale and the per-pair residuals. Exits 1 with FAIL if there are fewer than 3
pairs, the fit needs a mirror (pairs mismatched), or the max residual exceeds max_residual_m
(0.5 m unless set).

How to get good pairs: use features that exist in BOTH, such as structural columns or
corners, never the markers you want to map. Pair them by nearest neighbour after a coarse
fit on 2-3 obvious features; listing them in the wrong order gives metre-scale residuals.
Validate on something you did not fit (a pole, a cabinet) before trusting the transform.
"""
import json
import sys

import numpy as np


def fit(plan_px, model_m):
    p = np.array(plan_px, float) * [1, -1]
    q = np.array(model_m, float)
    pm, qm = p.mean(0), q.mean(0)
    spread = np.linalg.svd(p - pm, compute_uv=False)
    if spread[0] == 0 or spread[-1] < 1e-3 * spread[0]:  # coincident or on one line: undefined
        return "collinear"
    u, s, vt = np.linalg.svd((p - pm).T @ (q - qm))
    r = (u @ vt).T
    if np.linalg.det(r) < 0:
        return None
    scale = s.sum() / ((p - pm) ** 2).sum()
    return lambda xy: scale * ((np.array(xy, float) * [1, -1] - pm) @ r.T) + qm, 1 / scale


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    spec = json.load(open(sys.argv[1]))
    pairs = np.array(spec["pairs"], float).reshape(-1, 4)
    if len(pairs) < 3:
        print(f"FAIL: need 3 or more point pairs, got {len(pairs)}")
        sys.exit(1)
    result = fit(pairs[:, :2], pairs[:, 2:])
    if result == "collinear":
        print("FAIL: the pairs are coincident or (nearly) on one line; add pairs spread over the plan")
        sys.exit(1)
    if result is None:
        print("FAIL: the fit needs a mirror image; the point pairs are mismatched")
        sys.exit(1)
    to_model, px_per_m = result
    resid = np.linalg.norm(to_model(pairs[:, :2]) - pairs[:, 2:], axis=1)
    if not np.isfinite(resid).all() or not np.isfinite(px_per_m):
        print("FAIL: the fit is degenerate (coincident points?)")
        sys.exit(1)
    out = {"source": spec.get("source", ""), "px_per_m": round(px_per_m, 2),
           "residual_m": {"mean": round(float(resid.mean()), 3), "max": round(float(resid.max()), 3),
                          "each": [round(float(v), 3) for v in resid]},
           "markers": {k: [round(float(v), 3) for v in to_model(xy)] for k, xy in spec.get("markers", {}).items()}}
    print(f"{px_per_m:.1f} px/m, residual mean {resid.mean():.3f} m, max {resid.max():.3f} m")
    for k, v in out["markers"].items():
        print(f"  {k:12s} -> {v}")
    limit = spec.get("max_residual_m", 0.5)
    if resid.max() > limit:
        print(f"FAIL: max residual {resid.max():.3f} m exceeds {limit} m (no output written)")
        sys.exit(1)
    json.dump(out, open(sys.argv[2], "w"), indent=1)


if __name__ == "__main__":
    main()
