#!/usr/bin/env bash
# Proves web-acceptance.mjs can fail, and does not fail where it must not:
# - the compliant fixtures pass (ok.html in both text directions);
# - each broken fixture FAILs exactly the checks built to catch it;
# - each g-* fixture is a shape that once produced a false FAIL;
# - safety: a submit control is never auto-clicked, remote hosts are refused,
#   a weakened bar needs a reason, an ignore cannot swallow the page.
# Exit 0 only when every expectation holds.
#
#   selftest.sh            (needs python3, node, and Playwright; see SKILL.md)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/fixtures" >"$OUT/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$OUT"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:$PORT/ok.html')" 2>/dev/null && break
  sleep 0.3
done
BASE="http://127.0.0.1:$PORT"
WA="$HERE/web-acceptance.mjs"
bad=0

# route | extra args | expected exit | the EXACT set of FAIL ids (no more, no fewer)
expect() {
  local route=$1 extra=$2 want=$3 ids=$4 log="$OUT/${1%.html}.log" rc got wanted
  # shellcheck disable=SC2086
  node "$WA" --url "$BASE" --routes "/$route" --out "$OUT/shots" $extra >"$log" 2>&1
  rc=$?
  got=$(grep -oE '^  FAIL +[a-z-]+' "$log" | awk '{print $2}' | sort -u | xargs)
  wanted=$(printf '%s\n' $ids | sort -u | xargs)
  if [ "$rc" = "$want" ] && [ "$got" = "$wanted" ]; then
    echo "ok    $route exit $rc${got:+ (FAIL: $got)}"
  else
    echo "WRONG $route exit $rc (want $want) FAIL got [$got] want [$wanted]"
    sed 's/^/      /' "$log"; bad=1
  fi
}

# label | expected exit | text the output must contain | command...
expect_refusal() {
  local label=$1 want=$2 text=$3 rc; shift 3
  "$@" >"$OUT/refusal.log" 2>&1
  rc=$?
  if [ "$rc" = "$want" ] && grep -qF -- "$text" "$OUT/refusal.log"; then
    echo "ok    $label exit $rc"
  else
    echo "WRONG $label exit $rc (want $want, text \"$text\")"
    sed 's/^/      /' "$OUT/refusal.log"; bad=1
  fi
}

# Compliant pages, and shapes that once produced false FAILs.
expect ok.html              "--dirs ltr,rtl" 0 ""
expect g-smooth.html        ""               0 ""
expect g-wraplink.html      ""               0 ""
expect g-hashroute.html     ""               0 ""

# Each broken fixture trips exactly its own checks.
expect wide.html            ""               1 "hscroll offscreen text-spacing"
expect overlap.html         ""               1 "overlap"
expect clipped.html         ""               1 "clipped text-spacing"
expect target.html          ""               1 "target"
expect focus.html           ""               1 "focus-visible focus-onscreen"
expect b-tw-outline.html    ""               1 "focus-visible"
expect b-shadow0.html       ""               1 "focus-visible"
expect covered.html         ""               1 "pointer"
expect b-skipmissing.html   ""               1 "skip-link"
expect dialog-overflow.html ""               1 "overlay-fit overlay-scroll overlay-trap"
# The route redirects (/sheet -> /sheet/); axis 3 must still run.
expect sheet                ""               1 "overlay-fit overlay-scroll overlay-trap"

# Safety.
expect b-submit.html        ""               0 ""
if grep -q 'SIDE-EFFECT-HIT' "$OUT/server.log"; then
  echo "WRONG b-submit.html: the form was submitted"; bad=1
else
  echo "ok    b-submit.html: the submit button was not clicked"
fi
expect_refusal "remote host refused" 2 "refusing non-loopback host" \
  node "$WA" --url https://example.invalid --out "$OUT/shots"
expect_refusal "remote with --allow-remote: clicking forced off" 1 "WEAKENED autoOverlays" \
  node "$WA" --url https://example.invalid --allow-remote --out "$OUT/shots"
expect_refusal "weakened bar needs a reason" 2 'needs "weaken"' \
  node "$WA" --url "$BASE" --widths 390 --out "$OUT/shots"
printf '{"url":"%s","routes":["/ok.html"],"ignore":[{"selector":"body","reason":"x"}],"out":"%s"}' \
  "$BASE" "$OUT/shots" >"$OUT/broad.json"
expect_refusal "ignore swallowing the page refused" 2 "match html, body or main" \
  node "$WA" --config "$OUT/broad.json"

[ "$bad" = 0 ] && echo "SELFTEST PASSED" || echo "SELFTEST FAILED"
exit "$bad"
