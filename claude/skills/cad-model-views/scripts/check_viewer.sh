#!/usr/bin/env bash
# Measured acceptance for a served model viewer: phone layout at 320 px plus a selection test.
#
#   check_viewer.sh VIEWER_DIR URL HASH [OUT_DIR]
#   e.g. check_viewer.sh ./analysis/viewer http://127.0.0.1:8780/viewer/ "main/P-101" /tmp/out
#   HASH is "<model key>/<name>", URL-encoded; the first item whose name contains <name> is selected.
#
# The viewer must already be served at URL (from the directory that contains VIEWER_DIR).
# Checks at 320 x 640: no sideways scroll; no toolbar, selection bar, Info, Layers, Legend or
# search-results element outside the screen on any side (each dropdown closed and open, Info
# closed and open; search results opened with a query); buttons, selects, inputs and toggle rows
# at least 44 px tall; toolbar items do not overlap; the selection bar is one row (64 px at most)
# and Info starts closed; neither covers the canvas; at 640 x 360 (a landscape phone) with Info
# open the canvas keeps at least 120 px; legend swatches show their entry's exact
# colour; selecting a Legend entry highlights at least one part and fits the screen; a right
# click and a two-finger pinch on the canvas keep the selection while a left click changes it;
# the orbit pivot moves to a clicked part; an item from HASH is selected.
# Also saves desktop and phone screenshots to OUT_DIR so a human can look at them.
# Big models parse slowly in headless software GL; the time budget is generous on purpose.
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
VIEWER_DIR=$1; URL=$2; HASH=$3; OUT=${4:-$(mktemp -d)}
[[ $HASH != *[\"\<\>\ ]* ]] || { echo "HASH must be URL-encoded (no spaces, quotes or <>)" >&2; exit 2; }
mkdir -p "$OUT"
PROFILE=$(mktemp -d)
HARNESS_NAME="_check_viewer_$$.html"  # per-run name: parallel checks do not collide
HARNESS="$VIEWER_DIR/$HARNESS_NAME"
trap 'rm -rf "$PROFILE" "$HARNESS"' EXIT
BROWSER=$(command -v chromium chromium-browser google-chrome-stable google-chrome | head -1 || true)
[ -n "$BROWSER" ] || { echo "needs chromium or google-chrome" >&2; exit 2; }
CHROME=("$BROWSER" --headless=new --no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader
        --user-data-dir="$PROFILE" --virtual-time-budget=300000)

cat > "$HARNESS" <<EOF
<!doctype html><html><body style="margin:0"><pre id="out">pending</pre>
<iframe id="f" src="index.html#${HASH}" style="width:320px;height:640px;border:0"></iframe>
<script>
// Runs every second until done, one step per tick.
const issues = [];
let step = 0, before = null;
function frameOf() { return document.getElementById("f").contentWindow; }
function measure() {
  const w = frameOf(), d = w.document;
  if (!d.querySelector("#selbar.open") || !w.viewerState) return false;
  const bar$ = d.getElementById("selbar"), canvas = d.querySelector("#view canvas");
  const near = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9 * Math.max(1, Math.hypot(...b));  // same computation: equal
  const tap = (x, y, opts = {}) => {
    const r = canvas.getBoundingClientRect(), at = { clientX: r.left + x, clientY: r.top + y, bubbles: true };
    canvas.dispatchEvent(new w.PointerEvent("pointerdown", { pointerId: 1, button: 0, buttons: 1, pointerType: "mouse", ...at, ...opts }));
    canvas.dispatchEvent(new w.PointerEvent("pointerup", { pointerId: 1, button: 0, buttons: 0, pointerType: "mouse", ...at, ...opts }));
  };
  const state = () => (bar$.classList.contains("open") ? d.getElementById("sel-name").textContent : "") + "|" + bar$.dataset.selected;
  if (step === 0) {
    if (!near(w.viewerState().pivot, w.viewerState().selection)) issues.push("orbit pivot is not on the deep-linked selection");
    if (d.getElementById("info").classList.contains("open")) issues.push("Info starts open (it opens only on request)");
    if (bar$.getBoundingClientRect().height > 64.5) issues.push("selection bar taller than one row: " + bar$.getBoundingClientRect().height);
    layout(w, d);
    // A landscape phone with Info open must keep a usable canvas (measured on the next tick).
    document.getElementById("f").style.cssText = "width:640px;height:360px;border:0";
    d.getElementById("info-btn").click();
    step = "landscape"; return false;
  }
  if (step === "landscape") {
    const v = d.getElementById("view").getBoundingClientRect();
    if (v.height < 120) issues.push("landscape 640x360 with Info open leaves the canvas " + Math.round(v.height) + " px tall");
    if (d.documentElement.scrollWidth > w.innerWidth) issues.push("landscape 640x360 scrolls sideways");
    for (const el of d.querySelectorAll("#bar > *, #selbar, #info")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > w.innerWidth + 0.5 || r.bottom > w.innerHeight + 0.5)) issues.push("landscape 640x360: outside " + el.id);
    }
    d.getElementById("info-btn").click();
    document.getElementById("f").style.cssText = "width:320px;height:640px;border:0";
    step = 1; return false;
  }
  if (step === 1) {
    // A right click and a pinch in the canvas corner (empty in any framed model) keep the selection;
    // the left click there must change it, or the test never reached the picker.
    before = state();
    tap(3, 3, { button: 2, buttons: 2 });
    if (state() !== before) issues.push("a right click changed the selection");
    before = state();
    const r = canvas.getBoundingClientRect(), at = (x) => ({ clientX: r.left + x, clientY: r.top + 3, bubbles: true, pointerType: "touch" });
    canvas.dispatchEvent(new w.PointerEvent("pointerdown", { pointerId: 11, button: 0, ...at(3) }));
    canvas.dispatchEvent(new w.PointerEvent("pointerdown", { pointerId: 12, button: 0, ...at(60) }));
    canvas.dispatchEvent(new w.PointerEvent("pointerup", { pointerId: 12, button: 0, ...at(60) }));
    canvas.dispatchEvent(new w.PointerEvent("pointerup", { pointerId: 11, button: 0, ...at(3) }));
    if (state() !== before) issues.push("a two-finger pinch changed the selection");
    before = state();
    tap(3, 3);
    if (state() === before) issues.push("a left click in the empty corner did not change the selection (picking test is blind)");
    // Click the canvas centre (the old pivot, on the previous selection), then a 7 x 7 grid,
    // until a part is hit. An off-centre part is framed, which moves the pivot too.
    const cw = canvas.clientWidth, ch = canvas.clientHeight, spots = [[cw / 2, ch / 2]];
    for (let gy = 1; gy < 8; gy++) for (let gx = 1; gx < 8; gx++) spots.push([cw * gx / 8, ch * gy / 8]);
    for (const [x, y] of spots) {
      tap(x, y);
      if (bar$.classList.contains("open")) break;
    }
    if (!bar$.classList.contains("open")) { issues.push("no part found on the canvas for the pivot test"); return report(); }
    step = 2; return false;
  }
  if (!near(w.viewerState().pivot, w.viewerState().selection)) issues.push("orbit pivot did not move to the clicked part");
  return report();
}
function report() { document.getElementById("out").textContent = "CHECK " + JSON.stringify(issues); return true; }

function layout(w, d) {
  if (d.documentElement.scrollWidth > w.innerWidth) issues.push("page scrolls sideways");
  // Open the search results with a one-letter-pair query that matches something.
  const search = d.getElementById("search");
  search.value = d.getElementById("sel-name").textContent.slice(0, 2) || "a";
  search.dispatchEvent(new w.Event("input"));
  const infoBtn = d.getElementById("info-btn");
  for (const [pop, infoOpen] of [[null, false], ["layers", false], ["legend", false], [null, true]]) {
    for (const id of ["layers", "legend"]) d.getElementById(id).classList.toggle("open", id === pop);
    if ((infoBtn.getAttribute("aria-expanded") === "true") !== infoOpen) infoBtn.click();
    for (const el of d.querySelectorAll("#bar *, #selbar *, #info *, #layers *, #legend *, #results *")) {
      const r = el.getBoundingClientRect(), cs = w.getComputedStyle(el);
      if (!r.width || cs.display === "none" || cs.visibility === "hidden") continue;
      // Scrollable containers may hold content below their visible box; judge their box instead.
      const box = el.closest("#results, #info, #layers, #legend");
      const b = box && box !== el ? box.getBoundingClientRect() : r;
      if (r.left < -0.5 || r.right > w.innerWidth + 0.5 || b.top < -0.5 || b.bottom > w.innerHeight + 0.5)
        issues.push("outside: " + el.tagName + "#" + el.id + " " + Math.round(r.left) + "," + Math.round(r.top) + "-" + Math.round(r.right) + "," + Math.round(r.bottom));
      const target = ["BUTTON", "SELECT"].includes(el.tagName) || (el.tagName === "INPUT" && el.type !== "checkbox") || el.tagName === "LABEL";
      if (target && r.height < 44) issues.push("small target: " + el.tagName + " " + el.textContent.trim().slice(0, 24) + " h=" + r.height);
    }
    const view = d.getElementById("view").getBoundingClientRect();
    if (pop && d.getElementById(pop).getBoundingClientRect().bottom > view.bottom + 0.5) issues.push(pop + " dropdown taller than the view");
    if (infoOpen && !d.getElementById("info").classList.contains("open")) issues.push("Info did not open");
    for (const id of ["selbar", "info"]) {
      const p = d.getElementById(id).getBoundingClientRect();
      if (p.width && p.top < view.bottom - 0.5 && p.left < view.right - 0.5 && view.top < p.bottom - 0.5 && view.left < p.right - 0.5)
        issues.push(id + " covers the canvas" + (infoOpen ? " (Info open)" : ""));
    }
  }
  for (const sw of d.querySelectorAll("#legend .swatch")) {
    const n = parseInt(sw.dataset.colour, 16), rgb = w.getComputedStyle(sw).backgroundColor.match(/\d+/g).slice(0, 3).map(Number);
    if (rgb.join() !== [n >> 16, (n >> 8) & 255, n & 255].join()) { issues.push("legend swatch colour " + rgb + " != #" + sw.dataset.colour); break; }
  }
  const rows = d.querySelectorAll("#legend .legend-row:not(:disabled)");
  if (!rows.length) issues.push("legend has no selectable entries");
  else {
    rows[0].click();
    if (!d.querySelector("#legend .legend-row.active") || !(+d.getElementById("selbar").dataset.selected > 0)) issues.push("legend entry did not highlight anything");
    for (const el of d.querySelectorAll("#selbar *, #info *")) {
      const r = el.getBoundingClientRect(), b = el.closest("#selbar, #info").getBoundingClientRect();
      if (r.width && (r.left < -0.5 || r.right > w.innerWidth + 0.5 || b.bottom > w.innerHeight + 0.5)) { issues.push("selection after legend pick: outside " + el.tagName); break; }
    }
  }
  const res = d.getElementById("results");
  if (w.getComputedStyle(res).display === "none") issues.push("search results did not open");
  else if (res.scrollHeight > res.clientHeight + 1 && w.getComputedStyle(res).overflowY !== "auto") issues.push("search results do not scroll");
  const bar = [...d.querySelectorAll("#bar > *")].map((e) => e.getBoundingClientRect());
  for (let i = 0; i < bar.length; i++) for (let j = i + 1; j < bar.length; j++) {
    const a = bar[i], b = bar[j];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) issues.push("toolbar overlap " + i + "," + j);
  }
  // Leave Info closed and the legend popover shut for the pointer steps.
  if (infoBtn.getAttribute("aria-expanded") === "true") infoBtn.click();
  for (const id of ["layers", "legend"]) d.getElementById(id).classList.remove("open");
  res.style.display = "none";
}
const timer = setInterval(() => { if (measure()) clearInterval(timer); }, 1000);
</script></body></html>
EOF

run_check() { "${CHROME[@]}" --window-size=400,700 --dump-dom "${URL}${HARNESS_NAME}" 2>/dev/null | grep -o 'CHECK \[[^<]*' | head -1 || true; }
# The harness stays "pending" until the model has loaded and the HASH item is selected.
# Software GL under load is slow, so one retry before calling it a failure.
RESULT=$(run_check)
[ -n "$RESULT" ] || RESULT=$(run_check)
"${CHROME[@]}" --window-size=1400,900 --screenshot="$OUT/desktop.png" "${URL}#${HASH}" >/dev/null 2>&1 || true
"${CHROME[@]}" --window-size=320,640 --screenshot="$OUT/phone.png" "${URL}#${HASH}" >/dev/null 2>&1 || true
echo "screenshots: $OUT/desktop.png $OUT/phone.png (look at them)"
if [ "$RESULT" = "CHECK []" ]; then echo "PASS: 320 px layout and selection"; exit 0; fi
echo "FAIL: ${RESULT:-nothing selected (model did not load, or HASH matched nothing)}"; exit 1
