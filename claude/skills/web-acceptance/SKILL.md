---
name: web-acceptance
description: Measured phone acceptance for any user-facing web surface. Runs a Playwright script that measures the three binding axes per element (no horizontal scroll at 320px; nothing overlapping, clipped by an ancestor or off the viewport; every overlay, dialog and dropdown fits the phone and scrolls when taller), plus touch targets, keyboard and pointer reachability, visible focus, the dialog contract, text-spacing survival and announced form errors, in both text directions, with PASS/FAIL per check and a non-zero exit on any FAIL. Use before showing or shipping any web page, after any layout/CSS/component change, when asked whether a site is responsive, mobile-ready or accessible, and as a gate in a web project's verify chain.
---

# web-acceptance — the page is measured, then looked at

Built on a field-work product's public web app (2026-08/09). It shipped once with
zero `@media` rules and a fixed desktop grid; the owner opened it on a phone and
found text on text, hidden controls and dialogs hanging off-screen. A scrollWidth
check alone would have passed half of that. This skill is the measured bar that
replaced "it looks fine on my screen".

## 1. Doctrine (binding, from the global standard)

- **Mobile-first is a baseline, not a feature.** Base CSS is the phone layout;
  media queries ADD wider ones. Layout lives in CSS, never a JS width listener
  (a JS-measured layout paints wrong on every first load).
- **Acceptance is measured on three axes, all required, because each hides what
  the others miss:**
  1. no horizontal page scroll at 320px;
  2. no element overlapping, clipped by an ancestor, or positioned outside the
     viewport, checked per ELEMENT via `getBoundingClientRect`;
  3. every overlay, dialog and dropdown fits the phone and scrolls when taller.
- **Both text directions** when the product ships RTL. Media queries are
  direction-blind; a layout built on physical edges (`left`, `margin-right`)
  mirrors wrong. Use logical properties.
- **LOOK at a screenshot.** A numeric pass on a visibly broken page is the exact
  failure this bar exists to catch. The script writes the screenshots; reading
  them is not optional.
- **Touch targets >= 44px.** Never truncate a number, an amount or a name to
  nothing: unreadable is worse than absent.
- **A disclosure is not a mitigation.** "This page will be cramped on a phone"
  written in a report does not make it pass.

## 2. Run it

Requires `node` (>= 18), `python3` only for the self-test, and the **Playwright**
npm package (`playwright` or `playwright-core`) with its Chromium build. The
script installs nothing. It resolves Playwright from, in order:
`$PLAYWRIGHT_MODULE` (path to the package directory), the current directory's
`node_modules`, then the global npm root. Run it from the project that already
has Playwright as a dev dependency; if none does, that is a dependency decision
for the owner (see `vet-install`), not something to add silently.

```
S=~/.claude/skills/web-acceptance/scripts
node $S/web-acceptance.mjs --url http://localhost:5173 --routes /,/pricing
node $S/web-acceptance.mjs --url http://localhost:5173 --dirs ltr,rtl
node $S/web-acceptance.mjs --config web-acceptance.json
$S/selftest.sh
```

Flags: `--url`, `--routes a,b`, `--widths 320,390` (default 320), `--height`
(default 568, a small phone), `--dirs ltr,rtl` (forces `<html dir>`; a fallback
when the product has no locale switch), `--out DIR` for screenshots, `--json FILE`.
A static build can be served with `python3 -m http.server --bind 127.0.0.1` or
addressed as `file://`.

Exit: **0** every check PASS (WARN is advisory), **1** any FAIL, **2** usage,
config or setup error (Playwright missing, Chromium will not launch). Capture the
real exit code; never read it through a pipe.

### Config file (see `scripts/web-acceptance.example.json`)

| key | meaning |
|---|---|
| `url`, `routes`, `widths`, `height` | what to load and at which phone sizes |
| `directions` | `[{name, locale, localStorage, query, forceDir, expectDir}]`: how THIS product switches language; `expectDir` asserts the resulting `<html dir>` |
| `ignore` | `[{selector, reason}]`: elements excluded from per-element checks. A reason is required or the run exits 2 |
| `waive` | `{checkId: reason}`: the check still runs and prints, as WAIVED, and does not fail the run. Reason required |
| `overlays` | `[{route, open, panel}]`: explicit openers for overlays the auto-detection cannot find |
| `autoOverlays` | default true: clicks every non-link control declaring a popup (`aria-haspopup`, `aria-expanded="false"`, `popovertarget`, `commandfor`), up to `maxTriggers` (8) per page |
| `forms` | `[{route, fill, submit, waitMs}]`: submits a deliberately bad form and checks the failure is announced |

## 3. What each check measures

| id | axis | FAIL when |
|---|---|---|
| `hscroll` | 1 | `documentElement.scrollWidth > clientWidth + 1`; names the widest elements |
| `offscreen` | 2 | a visible element extends past the viewport's sides (or a fixed one past top/bottom), is not inside a scroll container, and is not clipped by one |
| `clipped` | 2 | a text run or control is partly cut by an ancestor with `overflow: hidden/clip` (per axis; scrollers are reachable, so they are not clipping) |
| `truncated` | 2 | WARN only: the same cut, made on purpose with ellipsis or line-clamp. Read the screenshot and decide |
| `overlap` | 2 | two VISIBLE text fragments, or text and a control, or two controls, intersect by more than 2px and 40% of the smaller height, in the same layer (fixed/sticky chrome is a different layer) |
| `overlay-fit` | 3 | an opened dialog/menu/listbox/popover box exceeds the viewport (height only matters when it is pinned: fixed, modal or popover) |
| `overlay-scroll` | 3 | panel content is hidden by `overflow: hidden`, or spills off-screen with no scroller to reach it |
| `overlay-target`, `overlay-clipped` | 3 | the target and clip checks, scoped to the open panel |
| `overlay-focus` | dialog | focus did not move into a dialog on open |
| `overlay-trap` | dialog | with a modal open, 15 Tab + 15 Shift+Tab reached an element in the page behind (leaving the page for the browser chrome is allowed) |
| `overlay-escape`, `overlay-return` | dialog | Escape does not close it; focus does not return to the trigger |
| `target` | touch | an interactive control (label area counted for inputs) is under 44px in either dimension. Links inside a sentence are exempt (WCAG 2.5.8 inline exception) |
| `pointer` | reach | a control scrolled into view has something else on top of its centre (`elementFromPoint`) |
| `keyboard` | reach | a visible, enabled, tabbable control is never reached by Tab |
| `focus-visible` | focus | the focused element's computed outline, shadow, colours, decoration and transform (itself, its pseudo-elements, its parent) are identical to its unfocused state |
| `focus-onscreen` | focus | Tab lands on something invisible or outside the viewport (the closed off-canvas drawer whose links are still tabbable) |
| `skip-link` | focus | the first Tab is an in-page link whose target is missing. Not having one is a WARN |
| `text-spacing` | 1.4.12 | after the WCAG text-spacing override, the page scrolls sideways or clips text |
| `lang`, `dir`, `alt`, `tabindex` | basics | no `<html lang>`; direction differs from `expectDir`; `<img>` without `alt`; any positive `tabindex` |
| `form-error` | 3.3.1 | after a bad submit, nothing appears in a live region, no `aria-invalid` field has a described error, and native validation did not fire |
| `load`, `run` | | the page did not load (HTTP >= 400 or a navigation error), or a check crashed |

Deliberately exempt, so the FAIL classes stay free of false positives:
"parked" elements (fully off-canvas or clipped to nothing, such as skip links,
sr-only text and closed drawers) are excluded from layout and touch checks and
are judged by the keyboard walk instead; content inside scroll containers;
images and SVG in the overlap check (text over a hero image is a design choice
for the screenshot to judge); `inert` subtrees in the target and reach checks.
Animations run with
`prefers-reduced-motion: reduce` so measurements are not taken mid-transition.

## 4. What it cannot see — do these by eye, every time

- **The screenshots.** Open every 320px shot in both directions, and every
  overlay shot. Text over images, contrast, ugly-but-measurable layouts and
  meaning live there.
- Focus ORDER matching the visual order (the walk proves reach, not sense).
- Contrast of text and of the focus ring (run axe for text contrast; a focus
  ring at 3:1 is a design-token review).
- Whether alt text and error messages are CORRECT, not merely present.
- Wider widths: 320 is the bar, but run 390 and a tablet width once a layout
  has breakpoints, because a media query can break the middle.
- axe-core finds a different third of WCAG problems from the DOM. Where the
  project has `@axe-core/playwright`, run it as a separate scan over the same
  routes, both locales, at 320px and desktop; this script does not depend on it.

## 5. Proof and calibration

`scripts/selftest.sh` serves `scripts/fixtures/` on a random localhost port and
asserts the EXACT set of FAIL ids per fixture: `ok.html` passes in both
directions; `wide.html` (one 400px element) fails `hscroll` and `offscreen`;
`overlap`, `clipped`, `target`, `focus`, `covered` and `dialog-overflow` each
fail the check built for them and nothing else. Re-run it after changing the
script: a check that cannot fail is not a check.

When a real page produces a false positive, do not loosen the check by feel:
add the shape to a fixture, fix the measurement, prove the selftest still holds.
For a genuine exception, use `ignore`/`waive` with the written reason. When a
project adopts the script as a gate, the FAIL count is a ratchet: it may only
go down.

## 6. Reporting

Quote the measured value, not "PASS". A finished page's report carries the
command, the exit code, the FAIL lines (or "0 FAIL, N WARN, each read"), and the
screenshots that were opened. A FAIL that is accepted goes in the project's
decision ledger with the reason, and into `waive`.
