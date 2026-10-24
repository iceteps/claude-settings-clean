# web-acceptance

A single-file Playwright script that measures whether a web page is usable on a
phone, and exits non-zero when it is not.

## What it checks

At 320px wide (configurable), in each configured text direction, per route:

1. **No horizontal page scroll.**
2. **Per element:** nothing outside the viewport, nothing clipped by an ancestor,
   no text sitting on text or on a control.
3. **Every overlay** (dialog, menu, listbox, popover) fits the screen and scrolls
   when its content is taller; dialogs take focus, keep it out of the page
   behind, close on Escape and give focus back.

Plus touch targets of at least 44px, keyboard reachability of every control,
pointer reachability (nothing covering a control), a visible focus style at every
Tab stop, focus never landing off-screen, WCAG 1.4.12 text spacing, `lang`/`dir`,
image `alt`, positive `tabindex`, and announced form errors when configured.

Each check prints `PASS`, `FAIL`, `WARN` or `WAIVED` with the measured value.
A full-page screenshot is saved per route, width and direction, and one per
opened overlay.

## Install

Nothing to install beyond what a web project usually has:

- Node 18 or newer.
- The `playwright` (or `playwright-core`) npm package and its Chromium build.
  The script looks in `$PLAYWRIGHT_MODULE`, then `./node_modules`, then the
  global npm root.
- `python3`, only for `selftest.sh`.

## Usage

```
node web-acceptance.mjs --url http://localhost:5173 --routes /,/about
node web-acceptance.mjs --url http://localhost:5173 --dirs ltr,rtl
node web-acceptance.mjs --config web-acceptance.json --json result.json
./selftest.sh
```

| flag | default | meaning |
|---|---|---|
| `--url` | required | base URL (`http://`, `https://` or `file://`) |
| `--routes` | `/` | comma-separated paths appended to the URL |
| `--widths` | `320` | comma-separated viewport widths |
| `--height` | `568` | viewport height |
| `--dirs` | none | `ltr,rtl`: force `<html dir>` and assert it |
| `--out` | `web-acceptance-shots` | screenshot directory |
| `--json` | none | write every result as JSON |
| `--config` | none | JSON config; see `web-acceptance.example.json` |

Exit codes: `0` all checks pass, `1` at least one FAIL, `2` usage, config or
setup error.

Suppressions are config entries that must carry a reason: `ignore` excludes
elements by selector, `waive` turns a check id's FAIL into WAIVED. A missing
reason is a config error.

## How it works

An init script installs measuring helpers into every page before the page's own
scripts run. Each check is one `evaluate()` against those helpers, reading
`getBoundingClientRect`, `Range.getClientRects` for real text fragments,
computed styles for clipping and focus styles, and `elementFromPoint` for
pointer reachability. The keyboard walk presses Tab until focus cycles and
compares each stop with the element's unfocused style. Overlay triggers are
found by their ARIA popup attributes, clicked on a fresh load each, and the
newly visible panel is measured.

## Self-test

`selftest.sh` serves `fixtures/` on a random localhost port and checks that the
compliant page passes in both directions and that each broken fixture fails
exactly the checks it was built to trip. Run it after any change to the script.

## Limits

It measures; it does not judge. Read the screenshots. Focus order versus visual
order, colour contrast and the correctness of alt text and messages need a
human, or axe-core for contrast.
