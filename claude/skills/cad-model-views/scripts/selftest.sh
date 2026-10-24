#!/usr/bin/env bash
# Self-test for the cad-model-views skill. Run after any change to it, and once after installing.
#   bash ~/.claude/skills/cad-model-views/scripts/selftest.sh
# Each check guards a fault found in review (2026-10-21/22). Files are written only to a temp
# dir (python runs with -B; the last check proves no cache files were left in the skill).
# Needs python3 with numpy. The launcher check needs a systemd user session and is skipped
# without one; it runs `systemctl --user daemon-reload` on the live user manager (harmless).
set -uo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "PASS  $1"; }
no() { echo "FAIL  $1"; fails=$((fails + 1)); }

# 1. No personal or machine-specific paths inside the skill (any user, Linux or macOS).
HOME_RE='/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z]'
if grep -rIlE --exclude-dir=vendor --exclude=selftest.sh -e "$HOME_RE" -e "$HOME/" "$DIR" >/dev/null; then
  no "personal paths in the skill: $(grep -rIlE --exclude-dir=vendor --exclude=selftest.sh -e "$HOME_RE" -e "$HOME/" "$DIR" | head -3)"
else ok "no personal paths"; fi

# 2. register_plan: recovers a known transform; each refusal is tripped by its own case alone.
python3 -I -B - "$T" "$DIR/scripts/register_plan.py" <<'EOF' || fails=$((fails + 1))
import json, math, subprocess, sys
t, reg = sys.argv[1], sys.argv[2]
a, s, tx, ty = math.radians(37), 1 / 80, 12.0, -4.0     # model = R * (px, -py) / 80 + t
pts = [(100, 200), (900, 150), (400, 800), (1200, 900), (50, 600)]
def to_m(x, y, flip=1):
    X, Y = x * s, -y * s * flip
    return (math.cos(a) * X - math.sin(a) * Y + tx, math.sin(a) * X + math.cos(a) * Y + ty)
good = [[x, y, *to_m(x, y)] for x, y in pts]
noisy = [g[:] for g in good]; noisy[2][2] += 2.0          # one pair 2 m off: residual gate only
cases = {                                                   # name: (pairs, expected exit, FAIL text)
    "good": (good, 0, None),
    "two_pairs": (good[:2], 1, "3 or more"),
    "mirror": ([[x, y, *to_m(x, y, -1)] for x, y in pts], 1, "mirror"),
    "coincident": ([[500, 500, *to_m(x, y)] for x, y in pts], 1, "one line"),
    "collinear": ([[x, 2 * x, *to_m(x, 2 * x)] for x, _ in pts], 1, "one line"),
    "noisy": (noisy, 1, "residual"),
}
bad = 0
for name, (pairs, want, text) in cases.items():
    json.dump({"pairs": pairs}, open(f"{t}/{name}.json", "w"))
    r = subprocess.run([sys.executable, "-I", "-B", reg, f"{t}/{name}.json", f"{t}/{name}.out"],
                       capture_output=True, text=True)
    if r.returncode != want or (text and text not in r.stdout):
        print(f"FAIL  register_plan {name}: exit {r.returncode}, {r.stdout.strip()[-80:]!r}"); bad = 1
if not bad:
    res = json.load(open(f"{t}/good.out"))
    if res["residual_m"]["max"] > 1e-6 or abs(res["px_per_m"] - 80) > 1e-6:
        print("FAIL  register_plan did not recover the transform"); bad = 1
if not bad:
    print("PASS  register_plan: exact fit; refuses 2 pairs, mirror, coincident, collinear, 2 m outlier")
sys.exit(bad)
EOF

# 3. glb: same name + different content never merges; identical materials are shared.
python3 -I -B - "$DIR/scripts" <<'EOF' || fails=$((fails + 1))
import sys
sys.path.insert(0, sys.argv[1])
from glb import Glb, colour_material
g, tri = Glb(), ([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2])
mat = colour_material("M", "ff0000")
g.mesh("a", *tri, mat)
g.mesh("b", *tri, colour_material("M", "ff0000", 0.35))
g.mesh("c", *tri, colour_material("M", "ff0000"))
g.image_quad("P", b"one", [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
g.image_quad("P", b"two", [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
mat["pbrMetallicRoughness"]["baseColorFactor"][0] = 0   # caller edits its dict afterwards
used = [m["primitives"][0]["material"] for m in g.meshes]
ok = used[0] == used[2] != used[1] and used[3] != used[4] \
    and g.materials[used[0]]["pbrMetallicRoughness"]["baseColorFactor"][0] == 1
print("PASS  glb material sharing and copying" if ok else f"FAIL  glb material sharing {used}")
# The legend reaches the file as scene extras (the viewer's Legend dropdown), and only when given.
import json, os, struct, tempfile
def scene(legend):
    path = os.path.join(tempfile.mkdtemp(), "t.glb")
    g.write(path, "selftest", legend)
    with open(path, "rb") as f:
        f.read(12)
        return json.loads(f.read(struct.unpack("<II", f.read(8))[0]))["scenes"][0]
key = {"entries": [{"label": "Red", "colour": "ff0000", "alpha": 1.0, "materials": ["M"]}], "notes": []}
leg = scene(key).get("extras", {}).get("legend") == key and "extras" not in scene(None)
print("PASS  glb writes the legend as scene extras" if leg else "FAIL  glb scene legend")
sys.exit(0 if ok and leg else 1)
EOF

# 4. make_launcher: hostile display name, generated script is valid and quotes everything.
if command -v systemd-analyze >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$T/serve/viewer"; cp "$DIR/viewer/index.html" "$T/serve/viewer/"
  cp "$DIR/viewer/models.example.json" "$T/serve/viewer/models.json"
  NAME_HOSTILE='Bob "100%" $HOME `id` Viewer'
  if HOME="$T/home" bash "$DIR/scripts/make_launcher.sh" selftest "$T/serve" 8799 "$NAME_HOSTILE" >/dev/null 2>"$T/ml.err" \
     && bash -n "$T/home/.local/bin/selftest-view" \
     && grep -q '^TITLE=Bob\\ \\"100%\\"\\ \\$HOME\\ \\`id\\`\\ Viewer$' "$T/home/.local/bin/selftest-view" \
     && grep -q '100%%' "$T/home/.config/systemd/user/selftest-viewer.service" \
     && ! grep -qE '^\s*Restart\s*=' "$T/home/.config/systemd/user/selftest-viewer.service"; then
    ok "make_launcher quoting, % escaping, no restart policy"
  else no "make_launcher ($(tail -1 "$T/ml.err"))"; fi
  # Phone sharing: tailnet only, cleared on every server start and stop (non-interactively),
  # keep-awake BOUND to the server (PartOf misses the 12 h limit and crashes) with its own
  # backstop, and a login-time clear unit for mappings left by a power loss.
  U="$T/home/.config/systemd/user"; C="$T/home/.local/bin/selftest-view"
  if grep -q '^ExecStartPre=-/usr/bin/env tailscale serve --yes --http=8799 off$' "$U/selftest-viewer.service" \
     && grep -q '^ExecStopPost=-/usr/bin/env tailscale serve --yes --http=8799 off$' "$U/selftest-viewer.service" \
     && grep -q '^BindsTo=selftest-viewer.service$' "$U/selftest-viewer-awake.service" \
     && ! grep -q '^PartOf=' "$U/selftest-viewer-awake.service" \
     && grep -q '^RuntimeMaxSec=12h$' "$U/selftest-viewer-awake.service" \
     && grep -q 'systemd-inhibit --what=sleep:idle:handle-lid-switch' "$U/selftest-viewer-awake.service" \
     && grep -q 'boot-clear$' "$U/selftest-viewer-clear.service" && grep -q '^WantedBy=default.target$' "$U/selftest-viewer-clear.service" \
     && ! grep -v '^\s*#' "$C" | grep -q 'funnel' && grep -q 'serve --bg --http=' "$C"; then
    ok "make_launcher phone sharing: tailnet only, cleared with the server, keep-awake BindsTo, login clear"
  else no "make_launcher phone sharing unit/command lines"; fi
  # Only the viewer and model FILES inside the served folder may be mapped.
  eval "$(sed -n '/^phone_paths() {/,/^}/p' "$C")"
  R="$T/root"; mkdir -p "$R/viewer" "$R/work"; : > "$R/m.glb"; : > "$R/viewer/b.glb"; : > "$T/outside.glb"
  ln -s "$T/outside.glb" "$R/link.glb"
  printf '{"models":[{"key":"a","label":"A","url":"../m.glb"},{"key":"b","label":"B","url":"b.glb"}]}' > "$R/viewer/models.json"
  bad=0
  if [ "$(MODELS_JSON="$R/viewer/models.json" phone_paths | tr '\n' ' ')" != "viewer m.glb " ]; then bad=1; echo "  good models.json not mapped as expected"; fi
  for url in .. ../ ../. x/../.. ../work ../../outside.glb ../link.glb '../m.glb?x' '../*' /etc/passwd http://x/m.glb ../missing.glb; do
    printf '{"models":[{"key":"a","label":"A","url":"%s"}]}' "$url" > "$R/viewer/models.json"
    if MODELS_JSON="$R/viewer/models.json" phone_paths >/dev/null 2>&1; then bad=1; echo "  accepted: $url"; fi
  done
  [ $bad = 0 ] && ok "make_launcher phone maps only the viewer and model files; refuses root, folders, outside, symlinks" \
    || no "make_launcher phone path mapping"
  rejected=1
  for args in "Bad_Name|8799|X" "okname|0999|X" "okname|1000|X" "okname|8799|" "okname|8799|.hidden"; do
    IFS='|' read -r n p d <<< "$args"
    HOME="$T/home2" bash "$DIR/scripts/make_launcher.sh" "$n" "$T/serve" "$p" "$d" >/dev/null 2>&1 && { rejected=0; echo "  accepted: $args"; }
  done
  [ $rejected = 1 ] && ok "make_launcher rejects bad NAME, PORT and display names" || no "make_launcher accepted bad input"
else echo "SKIP  make_launcher (no systemd user session)"; fi

# 5. Usage errors are errors.
bash "$DIR/scripts/render.sh" x.glb "$T/x.png" nonsense >/dev/null 2>&1; [ $? = 2 ] && ok "render.sh rejects unknown view" || no "render.sh accepted an unknown view"
grep -q -- '--up="\$up"' "$DIR/scripts/render.sh" && grep -q 'up=+Z' "$DIR/scripts/render.sh" && grep -q 'up=+Y' "$DIR/scripts/render.sh" \
  && ok "render.sh sets the up axis per format" || no "render.sh lost its per-format up axis"
python3 -I -B "$DIR/scripts/subset.py" a b --kep 1 >/dev/null 2>&1 && no "subset.py accepted --kep" || ok "subset.py rejects unknown mode"
python3 -I -B "$DIR/scripts/register_plan.py" >/dev/null 2>&1; [ $? = 1 ] && ok "register_plan.py without arguments prints usage" || no "register_plan.py without arguments"
bash "$DIR/scripts/check_viewer.sh" >/dev/null 2>&1; [ $? = 2 ] && ok "check_viewer.sh without arguments prints usage" || no "check_viewer.sh without arguments"

# 6. Vendored three.js unchanged.
(cd "$DIR/viewer/vendor/three-0.169.0" && sha256sum -c --quiet SHA256SUMS) && ok "three.js checksums" || no "three.js checksums"

# 7. This test left nothing behind in the skill.
[ -z "$(find "$DIR" -name __pycache__ -o -name '*.pyc' | head -1)" ] && ok "no cache files in the skill" || no "cache files left in the skill"

echo "$fails check(s) failed"
exit "$fails"
