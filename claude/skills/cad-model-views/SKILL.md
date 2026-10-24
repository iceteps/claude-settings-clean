---
name: cad-model-views
description: Turn a large, unnamed CAD export (STEP/STP, often hundreds of MB from SolidWorks) into fast, labelled, shareable views — split it into identifiable groups by geometry, build quick-load glTF files for F3D with colours, legends and tag plates, register drawings (site plans, P&IDs, electrical layouts) onto the model, and serve a click-to-select web viewer with a selection bar, details on demand and a one-step launcher. Use when someone sends a STEP/STP/IGES model to inspect, asks what is in a 3D model, wants a part of a model isolated or coloured, wants drawing data placed in 3D, or wants a model viewable or shareable. Pairs with `eplan-drawings` for electrical data.
---

# cad-model-views: from a nameless STEP to a clickable, labelled model

Everything here was learned on a real 855 MB SolidWorks export with no part names (9.4 million
"NONE" labels, no assembly, no colours). The method does not depend on that project, but the
traps in it do recur.

**Toolkit in this skill** (`SKILL_DIR=~/.claude/skills/cad-model-views`):

| Path | Does |
|---|---|
| `scripts/extract_shells.py` | freecadcmd: STEP to `model.brep` cache, `shells.json` (bbox, area, faces, face kinds per shell) and `shells.obj` (coarse mesh per shell) |
| `scripts/shells_query.py` | Find shells by box, distance, size, face count or kinds; write id lists |
| `scripts/subset.py` | Write an OBJ with only (or without) given shell ids |
| `scripts/render.sh` | Headless F3D screenshot (top north-up, iso, iso2) of an OBJ (Z up, flat colour) or glb (Y up, its own colours); if F3D fails with a GLX error, pass `--rendering-backend=egl` |
| `scripts/glb.py` | Minimal glTF writer: shared materials, node `extras`, self-lit image quads (legends, tag plates) |
| `scripts/register_plan.py` | Fit a drawing image onto model coordinates from point pairs; map markers; fail on mirror or residual |
| `viewer/` | Click-to-select web viewer (three.js r169 vendored, checksummed); reads `models.json` |
| `scripts/make_launcher.sh` | One-step launcher: user service, `NAME-view` command, app-launcher entry, phone sharing over Tailscale |
| `scripts/check_viewer.sh` | Measured acceptance for a served viewer: 320 px layout on all edges, Layers and search dropdown, touch targets, selection |
| `scripts/selftest.sh` | Self-test of this skill; run it after installing or changing anything here |

**Explore from here, build from a copy.** Run the scripts from `$SKILL_DIR` while exploring
(steps 1-2). Once a project has builders that produce deliverables, copy the scripts they import
(`glb.py`, the viewer) into the project's own working folder, for example
`analysis/work/tools/`. The project then rebuilds the same way next year, and an update to this
skill never changes a delivered view behind anyone's back.

## Requirements

- `python3` with `numpy` and `pillow`. The scripts run with `python3 -I`, which ignores
  `pip install --user` packages: install them system-wide or in the interpreter you run.
- FreeCAD's command line (`freecadcmd`; `FreeCADCmd` on some distros) for STEP extraction, and
  F3D for quick-load viewing and renders.
- For the viewer: a local `python3`, a browser, and `chromium` or `google-chrome` for
  `check_viewer.sh`. For the launcher: Linux with a systemd user session and `curl`;
  `desktop-file-validate` is used when present. For viewing on a phone: Tailscale on the
  machine and the phone, and `qrencode` for the scan-to-open code (optional).
- Related skills named below (`vet-install`, `resilient-long-op`, `gate-scripts`,
  `eplan-drawings`) are used if installed; the method works without them.

## 0. Before touching the file

- **Vet the tools, not just the file.** FreeCAD and F3D from the distro repos are fine.
  Anything that adds a network listener with code execution (FreeCAD MCP servers, RPC add-ons)
  is a decision for the user (`vet-install`, if installed). Driving `freecadcmd` with scripts adds no attack
  surface and is the default.
- **Confirm what is in the file** before promising anything. Check: the STEP header
  (`FILE_NAME`, the exporting program, AP203/AP214/AP242), whether `PRODUCT` names are real or
  all `NONE`, the assembly links, and the colours (`grep -c` on the entity types). A STEP holds
  finished solids only; editing design features needs the native files.
- **Anything over a few minutes runs as a resumable systemd unit** (`resilient-long-op`).
  Reading an 855 MB STEP takes minutes and 4-5 GB RAM; the BREP cache then reloads in seconds.

## 1. Extract once, query forever

```
systemd-run --user --unit=step-extract -E STEP_SRC=/path/model.STEP -E OUT_DIR=/path/work \
  freecadcmd $SKILL_DIR/scripts/extract_shells.py      # writes model.brep, shells.json, shells.obj, DONE
python3 -I $SKILL_DIR/scripts/shells_query.py work/shells.json --near X Y R --min-size 1
```

All later work reads `shells.json` and `shells.obj`, never the STEP again. Units: the STEP is
millimetres with Z up; everything a person reads is metres.

## 2. Identify things by geometry, and say so

With no names, identity comes from position, size, shape and repetition. What worked:

- **The building** is the handful of huge shells; everything else is equipment.
- **Repeated identical shells** (same face count and same sorted extents) are the same product:
  pumps on a rack, posts, columns. Group them first.
- **Tubes**: face kinds are a subset of {Cylinder, Toroid, Cone, Plane}, with few faces. **Straight
  tubes are often 6-face boxes** (a thin rod), not cylinders, so test for both.
- **Lines through fittings**: join shells whose mesh vertices touch on a fine grid (15 mm), and
  stop at branches so two lines never merge at a manifold. Join hand-checked exceptions
  explicitly and list them in the script.
- **Never invent what the model does not contain.** Before drawing "the cables" or "the spray
  bars", search for them. A thin rod at the right height may be a pipe, a beam or a sensor ray.
  If the model lacks the thing, a derived version must be labelled derived (section 4).
- **Look, every time.** `render.sh` the group top and iso, and compare it with a render or
  photo from the supplier. A wrong grouping looks wrong immediately.

Record each group as an id file (`ids_<group>.txt`) and keep the selection rules in the script
that wrote it. A FreeCAD `.FCStd` with one object per group gives the user hide/show in a
real CAD tool.

## 3. Quick-load files (F3D)

Build glTF binaries with `glb.py`, never OBJ/MTL: F3D lights OBJ colours near-black and makes
every object its own actor.

- **One merged mesh per colour for F3D.** One node per part made a 2,274-part file take 21 s to
  open instead of 1.4 s. Below about 100 nodes, per-element nodes are fine.
- **Write two files when the parts count is high**: merged for F3D, and one node per part with
  `extras` for the web viewer, from the same geometry in the same run.
- **Axis**: `glb.from_step()` converts STEP mm Z-up to glTF metres Y-up as `(x, z, -y)/1000`.
- **Legend board and tag plates**: self-lit textured quads (emissive texture, black base), drawn
  from the SAME tables that colour the model, so the key cannot disagree with the model. Face
  them along F3D's default camera: plate direction `(0.7071, 0, -0.7071)`, up `+Y`. Stack plate
  heights automatically so that none overlap in that view, and keep plates above clutter
  (overhead trays and pipe racks) in dense rooms.
- **The same key goes into the file as data**: `Glb.write(path, generator, legend)` stores it as
  scene `extras.legend` (`title`, `entries` of `label`/`colour`/`alpha`/`materials`/optional
  `section`, `notes`), which the viewer shows as its Legend dropdown. `colour` is sRGB hex
  and is painted as is (`THREE.Color` would linearise it and darken every swatch). Build the board image and
  this dict from ONE `legend_data()` function, so the two cannot drift. A STYLE row that shares
  another row's meaning (the same item for another unit) adds its material to that entry.
- **Honesty in the picture**: an item that is known but not modelled is a see-through copy
  (alpha 0.35) with its own legend entry. A derived route is solid only where it follows
  modelled geometry; assumed legs are see-through. Never draw a guess solid.
- **Keep the view focused**: an electrical view shows no pipework; a hydraulics view shows no
  cables. Context (building floor, frames, trays) is grey.
- **F3D keys that hurt on big models**: R (ray tracing, has crashed F3D 3.5), O, J, F, Q
  (ambient occlusion, on by default for OCCT). Open with `--ambient-occlusion=false`. Ctrl+Q
  quits; Esc opens a console. Uppercase `.STEP` needs `--force-reader=STEP`.

## 4. Put drawing data into the model

- **Register drawings with `register_plan.py`.** Render the sheet at a known dpi
  (`pdftoppm -r 200`). Pair 6-8 structural features visible in both, such as columns, and pair
  them by nearest neighbour after a coarse fit. Then **validate on features you did not fit**:
  poles, cabinets, panels. A good fit landed independent poles within 0.04-0.14 m. A swapped
  hypothesis put the main cabinet outside the building, which is how to choose between two
  plausible fits.
- **Write the mapped positions and the matched shell ids to a JSON file** that the builder
  reads. Positions are data, never constants buried in code.
- **Derived routes** (cables along trays and similar): build an occupancy grid of the modelled
  carrier, run Dijkstra between the nearest cells, simplify, and record for every route the
  drawn length split into modelled and assumed. Check it against the drawing's allowance (a
  drawn route longer than the cable list is a bug).

## 5. The click-to-select viewer

```
cp -r $SKILL_DIR/viewer <project>/analysis/viewer          # page + vendored three.js
cp $SKILL_DIR/viewer/models.example.json <project>/analysis/viewer/models.json   # edit
$SKILL_DIR/scripts/make_launcher.sh <name> <project>/analysis <port> "<Name> Viewer"
```

- **The data contract is node `extras`** (flat strings):
  - `name`: the item's name, used for search and deep links.
  - `Group`: the layer toggles. It is also shown under Info. `Tag plates` are never faded;
    the `Legend` board fades with everything else while something is selected (the Legend
    dropdown carries the same key).
  - optional `select`: parts with the same value highlight together, such as all pieces of one
    cable or line. When present, it is the selection title instead of `name`.
  - every other field appears under Info, in order.
  - scene `extras.legend` (section 3) feeds the Legend dropdown; without it the viewer lists
    one entry per plain-coloured material, named after the material.

  A builder that writes these needs no viewer change. Cyan is the highlight colour, so keep it
  out of model colour schemes.
- **Features**: orbit/pan/zoom, tap or click to select (cyan, everything else
  fades), a one-row selection bar with details under Info, search over every field, layer
  toggles, a Legend dropdown (tap an entry to highlight and frame every part in it), Esc to
  clear, `f` to frame the selection, deep links `#<model>/<name>`.
- **Mouse and touch** (owner finding 2026-10-22: right-dragging after a selection lost it).
  Left drag or one finger turns, right drag or Shift+drag or two fingers pans, the wheel or a
  pinch zooms. Only a LEFT click or a ONE-finger tap selects; a right or middle click and a
  pinch never change the selection. The orbit pivot moves to whatever is selected (the camera
  stays put and turns to face it; a part outside the canvas is framed instead), so turning
  goes around the selection. Camera moves glide for 350 ms and any drag takes over at once;
  `prefers-reduced-motion` makes them instant.
- **Nothing may cover the selection, and the selection UI stays small** (owner findings
  2026-10-22: the panel first hid the part it described, then the docked panel was "way too
  big"). While something is selected, a ONE-ROW bar sits under the canvas on every screen
  width: name, Zoom, Info, and a clear button. The details open only with Info, which is
  remembered per browser: a sheet under the bar on a phone (at most 40% of the height, it
  scrolls), a side column (340 px, at most 45% of the width) from 900 px and on a landscape
  phone (600 px wide, at most 500 px tall), where the toolbar is one row as well. Both are DOCKED, never overlaid; the canvas
  resizes and the pivot keeps the selection centred. Only the dropdowns (Layers, Legend,
  search results) overlay the canvas, one at a time, and they close when a choice is made.
  `check_viewer.sh` fails if the bar grows past one row, Info starts open, either covers the
  canvas, a landscape phone with Info open keeps under 120 px of canvas, or a right click or
  pinch changes the selection.
- **It needs a local server** (browsers refuse to load a glb from file://). `make_launcher.sh`
  makes a user service on 127.0.0.1 only, started on demand and stopping after 12 h, plus a
  `<name>-view` command and a launcher entry (one action per model, phone sharing, stop). It
  uses Omarchy's web-app window when present, otherwise a Chromium app window or the default
  browser. Optional `COMMENT=` and `DOC=` set the launcher tooltip and the unit's
  Documentation= link; regenerate an existing launcher with `FORCE=1`.
- **Acceptance is measured**: run `check_viewer.sh` against the served viewer, and look at the
  two screenshots. Headless software GL is slow and timing varies: the script uses a long
  budget and retries once before failing.

## 5a. Viewing on a phone (machine stays somewhere safe)

The use case: the laptop stays plugged in somewhere clean and safe (site office, car, home),
and the phone on site opens the viewer through it. The phone downloads nothing permanent and
needs no app beyond Tailscale and its browser, so it works on phones that cannot open CAD
files themselves.

**How it works.** `<name>-view phone` starts the local server if needed and maps it onto the
user's own tailnet with `tailscale serve --http=<port>`. Only the viewer folder and the model
files listed in `models.json` are mapped; every other file in the served folder returns 404.
A model url that is a folder, the root, outside the folder or a symlink out of it is refused.
The traffic is WireGuard-encrypted; plain HTTP is used so that no tailnet HTTPS certificates
are needed. It is NEVER `tailscale funnel` (public internet). A keep-awake unit blocks sleep,
idle suspend and the lid switch while sharing (verified as a granted block-mode inhibitor;
a real lid close is part of the phone acceptance below).

**When sharing ends** (each verified live, 2026-10-22): `<name>-view phone off`;
`<name>-view stop`; the server's 12 h limit; a crash of the server (both the mapping and the
keep-awake end: keep-awake is `BindsTo` the server, because `PartOf` would leave the machine
unable to sleep after the 12 h limit or a crash). Two gaps are covered by later clean-ups, not
at the moment itself: a power loss (Tailscale restores its serve settings at boot) and a
manual `systemctl --user kill` (systemd skips the stop hook). For both, the
`<name>-viewer-clear.service` login unit removes the mapping when no server is running, and
every server start removes it too.

**One-time setup**

1. Tailscale on the machine, logged in (`tailscale status` shows it).
2. Let the user run `tailscale serve` without sudo, once: `sudo tailscale set --operator=$USER`.
   (`tailscale debug prefs` shows `OperatorUser` when this is already done.)
3. Tailscale app on the phone, logged in to the SAME account; it appears in `tailscale status`.
4. Optional: `qrencode` installed, for the scan-to-open code.
5. Recommended: restrict who can reach the port. By default EVERY device on the tailnet can
   open the share (old or untrusted machines included). In the Tailscale admin console's
   access-control policy, allow `tcp:<port>` to the laptop from the phone only.

**Every time**

1. Plug the laptop into power. Leave it open or closed but ventilated, never in a closed bag:
   it will not sleep while shared.
2. Run `<name>-view phone` (or `<name>-view phone <model>`), or pick "Share to phone
   (Tailscale)" in the app launcher. It prints the link and a QR code (from the launcher, the
   QR opens as an image and the link arrives as a notification).
3. On the phone: Tailscale app connected, then scan the QR or open the link in the browser.
   Add it to the home screen for one-tap access.
4. When done: `<name>-view phone off` (server keeps running for the laptop) or
   `<name>-view stop` (everything off). `<name>-view status` shows whether sharing is on.

**Troubleshooting**

| Symptom | Cause and fix |
|---|---|
| Phone cannot open the link | The Tailscale app on the phone is off or on another account; or the laptop is offline or asleep. Check `tailscale status` on both |
| "tailscale serve failed ... permission" | Setup step 2 not done |
| Link opens, model never loads | Slow mobile data: the glb files are tens of MB on first load; wait, or use site Wi-Fi |
| Worked yesterday, not today | The 12 h limit ended sharing; run `<name>-view phone` again |
| "Cannot share: a model in models.json is not a file..." | A model url points at a folder, outside the served folder, or through a symlink; fix models.json |
| `status` says Keep-awake ON but sharing off | Run `<name>-view phone off`; it clears both |

**Acceptance for a phone release**: `check_viewer.sh` covers the 320 px layout; also open the
link on a real phone once over mobile data (not Wi-Fi), select a part, open the Legend and
Info, close the laptop lid for a minute and confirm the phone still loads, and confirm that
`<name>-view phone off` makes the link stop working.

## 6. Verify like it matters

- Counts from the builder output must match the documented breakdown.
- The registration residual and the independent-feature offsets are gated, for example
  max 0.3 m.
- Every node in a viewer file carries `name` and `Group`.
- Every viewer file carries a scene legend that keys every plain-coloured material, with no row
  that matches nothing (a variant that the build did not use is fine).
- The F3D file opens in about 2 s; time it after any change to the node structure.
- Render before/after images and diff them when refactoring a builder; only draw-order noise
  may differ.
- Turn each of these into the project's own verify script (`gate-scripts` doctrine, if
  installed), and prove each gate by injecting the fault it guards against. A gate that cannot
  fail is worse than none: check that it fails on missing items, not just on bad values.
- Phone sharing ends with the server: the unit clears the tailnet mapping on start and stop
  (`--yes`, never prompting), the keep-awake unit is `BindsTo` the server with its own 12 h
  backstop, and the login clear unit is enabled. Check what systemd LOADED
  (`systemctl --user show`), not the file text: a drop-in can override it. `selftest.sh`
  checks the generated files and the path refusals.
- After changing this skill, run `scripts/selftest.sh`.

## Sharing

The skill folder is self-contained: scripts, viewer and vendored three.js with its licence and
checksums. Delivered views (glb files plus a viewer folder) can be zipped and opened anywhere
with `python3 -m http.server` from the folder above the viewer. Client data stays in the
project folder, never in this skill.
