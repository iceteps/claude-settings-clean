#!/usr/bin/env node
/**
 * web-acceptance — measured phone acceptance for any web surface.
 *
 * The three binding axes, measured per page at each width and text direction:
 *   1. no horizontal page scroll at 320px;
 *   2. no element overlapping, clipped by an ancestor, or positioned outside
 *      the viewport (per element, via getBoundingClientRect);
 *   3. every overlay, dialog and dropdown fits the phone and scrolls when taller.
 * Plus what axe cannot see: keyboard reachability, visible focus, focus landing
 * off-screen, pointer reachability (a control covered by another element),
 * touch targets, the dialog contract (focus in, no leak behind, Escape, focus
 * back), WCAG 1.4.12 text-spacing survival, and announced form errors.
 *
 *   node web-acceptance.mjs --url http://localhost:5173 --routes /,/about
 *   node web-acceptance.mjs --config web-acceptance.json
 *
 * Every check prints PASS / FAIL / WARN / WAIVED with its measured value.
 * Exit: 0 all PASS (WARN is advisory), 1 any FAIL, 2 usage, config or setup error.
 * Screenshots land in --out (default ./web-acceptance-shots); a human or agent
 * must LOOK at them: a numeric pass on a visibly broken page is the failure
 * this tool exists to catch.
 *
 * SAFETY: it clicks popup triggers and submits configured forms. Point it only
 * at a local dev server, a static build or a disposable preview with throwaway
 * data. Non-loopback hosts are refused unless --allow-remote is given, and then
 * clicking and form submission stay off unless "remoteInteractions" is true.
 *
 * Needs the `playwright` (or `playwright-core`) npm package plus its Chromium.
 * Resolution order: $PLAYWRIGHT_MODULE (path to the package dir), the current
 * directory's node_modules, then the global npm root.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/* ───────────────────────────── configuration ───────────────────────────── */

const USAGE = `usage: web-acceptance.mjs (--url URL [--routes /a,/b] | --config FILE)
  [--widths 320,390] [--height 568] [--dirs ltr,rtl] [--out DIR] [--json FILE]
  [--allow-remote]`;

const DEFAULTS = {
  url: null,
  routes: ['/'],
  widths: [320],
  height: 568,
  directions: [{ name: 'default' }],
  settleMs: 250,
  minTarget: 44,
  maxTriggers: 8,
  out: null,
  json: null,
  ignore: [],
  waive: {},
  overlays: [],
  autoOverlays: true,
  forms: [],
  weaken: {},
  remoteInteractions: false,
};

const BOOLEAN_FLAGS = new Set(['allow-remote']);
// Settings that lower the bar. Each needs a written reason under "weaken".
const WEAKENINGS = [
  ['minTarget', (c) => c.minTarget < 44, (c) => `minTarget ${c.minTarget} < 44`],
  ['widths', (c) => !c.widths.includes(320), (c) => `widths [${c.widths}] do not include 320`],
  ['autoOverlays', (c) => c.autoOverlays === false, () => 'autoOverlays off: axis 3 only covers explicit overlays'],
  ['maxTriggers', (c) => c.maxTriggers === 0, () => 'maxTriggers 0: no popup trigger is opened'],
];
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

function die(msg) {
  console.error(`web-acceptance: ${msg}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) die(`unexpected argument ${k}`);
    if (BOOLEAN_FLAGS.has(k.slice(2))) { out[k.slice(2)] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(`${k} needs a value`);
    out[k.slice(2)] = v;
    i++;
  }
  return out;
}

function loadConfig() {
  const cli = parseArgs(process.argv.slice(2));
  let file = {};
  if (cli.config) {
    try { file = JSON.parse(readFileSync(cli.config, 'utf8')); } catch (e) { die(`cannot read config ${cli.config}: ${e.message}`); }
  }
  const cfg = { ...DEFAULTS, ...file };
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  if (cli.url) cfg.url = cli.url;
  if (cli.routes) cfg.routes = list(cli.routes);
  if (cli.widths) cfg.widths = list(cli.widths).map(Number);
  if (cli.height) cfg.height = Number(cli.height);
  if (cli.out) cfg.out = cli.out;
  if (cli.json) cfg.json = cli.json;
  if (cli.dirs) cfg.directions = list(cli.dirs).map((d) => ({ name: d, forceDir: d, expectDir: d }));

  if (!cfg.url) die('no --url (or "url" in the config)');
  cfg.url = cfg.url.replace(/\/$/, '');
  if (!cfg.widths.every((w) => Number.isFinite(w) && w > 0)) die('widths must be positive numbers');
  // Suppressions carry a written reason, or they are refused.
  for (const ig of cfg.ignore) {
    if (!ig || typeof ig.selector !== 'string' || !ig.reason) die('every "ignore" entry is {selector, reason} with a non-empty reason');
  }
  for (const [id, reason] of Object.entries(cfg.waive)) {
    if (!reason) die(`waive.${id} needs a written reason`);
  }

  // Safety: the run clicks and submits. Only loopback or file:// by default.
  let target;
  try { target = new URL(cfg.url); } catch { die(`not a URL: ${cfg.url}`); }
  const local = target.protocol === 'file:' || LOOPBACK.test(target.hostname);
  if (!local && !cli['allow-remote']) die(`refusing non-loopback host ${target.hostname}: pass --allow-remote (clicking and form submission then stay off)`);
  if (!local && !cfg.remoteInteractions) {
    if (cfg.autoOverlays) { cfg.autoOverlays = false; cfg.weaken.autoOverlays = cfg.weaken.autoOverlays || 'remote host: no clicking'; }
    if (cfg.forms.length) { cfg.forms = []; console.log('WEAKENED forms: remote host, configured form submissions skipped'); }
  }

  for (const [key, weak, what] of WEAKENINGS) {
    if (!weak(cfg)) continue;
    if (!cfg.weaken[key]) die(`${what(cfg)}: lowering the bar needs "weaken": {"${key}": "<reason>"}`);
    console.log(`WEAKENED ${what(cfg)} [reason: ${cfg.weaken[key]}]`);
  }

  cfg.out = resolve(cfg.out || join(tmpdir(), `web-acceptance-${Date.now()}`));
  return cfg;
}

function loadPlaywright() {
  const roots = [];
  if (process.env.PLAYWRIGHT_MODULE) roots.push({ direct: resolve(process.env.PLAYWRIGHT_MODULE) });
  roots.push({ base: join(process.cwd(), 'noop.js') });
  try { roots.push({ base: join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'noop.js') }); } catch { /* no npm */ }
  const req = createRequire(import.meta.url);
  for (const r of roots) {
    if (r.direct) {
      try { return req(r.direct); } catch { continue; }
    }
    const rq = createRequire(r.base);
    for (const name of ['playwright', 'playwright-core']) {
      try { return rq(rq.resolve(name)); } catch { /* next */ }
    }
  }
  die('Playwright not found: set PLAYWRIGHT_MODULE, or run from a project that has playwright installed');
}

/* ─────────────────────────────── reporting ─────────────────────────────── */

const results = [];
let failures = 0;
let cfgRef = null;

function report(id, where, ok, measured, offenders = [], level = 'FAIL') {
  let status = ok ? 'PASS' : level;
  const waived = cfgRef.waive[id];
  if (!ok && waived) status = 'WAIVED';
  if (status === 'FAIL') failures++;
  const tail = offenders.length ? ` | ${offenders.slice(0, 3).join(' ; ')}${offenders.length > 3 ? ` (+${offenders.length - 3} more)` : ''}` : '';
  const why = status === 'WAIVED' ? `  [waived: ${waived}]` : '';
  console.log(`  ${status.padEnd(6)} ${id.padEnd(15)} ${measured}${tail}${why}`);
  results.push({ id, where, status, measured, offenders });
}

/* ───────────────────── in-page helpers (installed once) ──────────────────── */

// Runs inside every page before its own scripts. Everything the checks measure
// lives here so each check is one evaluate() and the logic is in one place.
function installHelpers() {
  if (window.__wa) return;
  const SCROLLS = new Set(['auto', 'scroll']);
  const CLIPS = new Set(['hidden', 'clip']);
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[tabindex]', '[contenteditable="true"]',
  ].join(',');
  const PANELS = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [popover]:popover-open';

  const isRoot = (el) => el === document.documentElement || el === document.body;
  const ignored = (el, ignore) => ignore.some((s) => { try { return !!el.closest(s); } catch { return false; } });
  const shown = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  const vw = () => document.documentElement.clientWidth;
  const vh = () => window.innerHeight;
  // Outermost fixed/sticky ancestor: content in a different layer legitimately
  // passes under or over it as the page scrolls, so it is never compared across.
  const layerOf = (el) => {
    let root = null;
    for (let a = el; a && !isRoot(a); a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === 'fixed' || p === 'sticky') root = a;
    }
    return root;
  };
  const inTopLayer = (el) => {
    for (let a = el; a; a = a.parentElement) {
      if (a.matches(':modal, :popover-open')) return true;
      if (getComputedStyle(a).position === 'fixed') return true;
    }
    return false;
  };
  // Parked = deliberately off-canvas until focused (skip links, sr-only text,
  // a closed drawer): fully outside the reachable page, or clipped to nothing.
  const parked = (el) => {
    const r = el.getBoundingClientRect();
    const fixed = layerOf(el) !== null;
    if (r.right <= 0 || r.left >= vw()) return true;
    if (r.bottom + (fixed ? 0 : window.scrollY) <= 0) return true;
    if (fixed && r.top >= vh()) return true;
    const s = getComputedStyle(el);
    return s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)';
  };
  // Per-axis visibility through clipping ancestors (the root and body are
  // skipped: their overflow propagates to the viewport, which is axis 1's job).
  const clipWalk = (start, rect, tolY) => {
    let doX = true; let doY = true;
    for (let a = start; a && !isRoot(a) && (doX || doY); a = a.parentElement) {
      const s = getComputedStyle(a);
      const clipsX = doX && CLIPS.has(s.overflowX);
      const clipsY = doY && CLIPS.has(s.overflowY);
      if (doX && SCROLLS.has(s.overflowX)) doX = false;
      if (doY && SCROLLS.has(s.overflowY)) doY = false;
      if (!clipsX && !clipsY) continue;
      const ar = a.getBoundingClientRect();
      if (ar.width <= 2 || ar.height <= 2) return { hidden: true };
      const inner = {
        left: ar.left + a.clientLeft, top: ar.top + a.clientTop,
        right: ar.left + a.clientLeft + a.clientWidth, bottom: ar.top + a.clientTop + a.clientHeight,
      };
      const cutX = clipsX && (rect.left < inner.left - 2 || rect.right > inner.right + 2);
      const cutY = clipsY && (rect.top < inner.top - tolY || rect.bottom > inner.bottom + tolY);
      if (!cutX && !cutY) continue;
      const none = rect.right <= inner.left || rect.left >= inner.right || rect.bottom <= inner.top || rect.top >= inner.bottom;
      if (none) return { hidden: true };
      const own = start.nodeType === 1 ? getComputedStyle(start) : s;
      const truncated = s.textOverflow === 'ellipsis' || own.textOverflow === 'ellipsis'
        || (s.webkitLineClamp && s.webkitLineClamp !== 'none');
      return { by: a, inner, truncated };
    }
    return {};
  };
  const textNodes = (root, ignore) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || !n.textContent.trim()) continue;
      if (p.closest('script,style,noscript,template,option,textarea')) continue;
      if (ignored(p, ignore) || !shown(p)) continue;
      out.push(n);
    }
    return out;
  };
  const interactives = (ignore, root = document) => [...root.querySelectorAll(INTERACTIVE)].filter((el) =>
    !el.disabled && el.getAttribute('tabindex') !== '-1' && !el.closest('[inert]')
    && !ignored(el, ignore) && shown(el));
  const inlineInText = (el) => {
    if (el.tagName !== 'A' || getComputedStyle(el).display !== 'inline') return false;
    const own = (el.textContent || '').trim().length;
    const around = (el.parentElement?.textContent || '').trim().length;
    return around > own + 10;
  };

  /* axis 1 */
  const hscroll = (ignore) => {
    const de = document.documentElement;
    const widest = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (ignored(el, ignore) || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw() + 1 || r.left < -1) {
        if (!widest.some((w) => w.contains(el))) widest.push(el);
        if (widest.length >= 3) break;
      }
    }
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders: widest.map(describe) };
  };

  /* axis 2: outside the viewport */
  const offscreen = (ignore) => {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (ignored(el, ignore) || !shown(el) || parked(el)) continue;
      const r = el.getBoundingClientRect();
      const fixed = layerOf(el) !== null;
      const offX = r.left < -1 || r.right > vw() + 1;
      const offY = fixed && (r.top < -1 || r.bottom > vh() + 1);
      if (!offX && !offY) continue;
      const clip = clipWalk(el.parentElement, r, 2);
      if (clip.hidden || clip.by) continue;            // clipped: the clip check owns it
      let scrollable = false;
      for (let a = el.parentElement; a && !isRoot(a); a = a.parentElement) {
        const s = getComputedStyle(a);
        if ((offX && SCROLLS.has(s.overflowX)) || (offY && SCROLLS.has(s.overflowY))) { scrollable = true; break; }
      }
      if (scrollable) continue;
      if (out.some((o) => o.contains(el))) continue;
      out.push(el);
    }
    return out.map((el) => {
      const r = el.getBoundingClientRect();
      return `${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)}]`;
    });
  };

  /* axis 2: clipped by an ancestor */
  const clipped = (ignore, root = document.body) => {
    const cut = []; const truncated = [];
    const seen = new Set();
    const consider = (owner, rect, start) => {
      const tolY = Math.max(2, rect.height * 0.2);
      const res = clipWalk(start, rect, tolY);
      if (!res.by || seen.has(owner)) return;
      seen.add(owner);
      const by = res.by === owner ? 'its own overflow' : describe(res.by);
      (res.truncated ? truncated : cut).push(`${describe(owner)} cut by ${by}`);
    };
    for (const n of textNodes(root, ignore)) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const rect = range.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      consider(n.parentElement, rect, n.parentElement);
    }
    for (const el of root.querySelectorAll('input:not([type="hidden"]),select,textarea,button,img')) {
      if (ignored(el, ignore) || !shown(el) || parked(el)) continue;
      consider(el, el.getBoundingClientRect(), el.parentElement);
    }
    return { cut, truncated };
  };

  /* axis 2: overlap (text on text, text on control, control on control) */
  const overlap = (ignore) => {
    const boxes = [];
    for (const n of textNodes(document.body, ignore)) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const owner = n.parentElement;
      const layer = layerOf(owner);
      for (const raw of range.getClientRects()) {
        if (raw.width <= 0.5 || raw.height <= 0.5) continue;
        // Only the VISIBLE part of a fragment can sit on something: text an
        // ancestor clips away is the clip check's finding, not an overlap.
        const clip = clipWalk(owner, raw, 0);
        if (clip.hidden) continue;
        const r = clip.by ? {
          left: Math.max(raw.left, clip.inner.left), right: Math.min(raw.right, clip.inner.right),
          top: Math.max(raw.top, clip.inner.top), bottom: Math.min(raw.bottom, clip.inner.bottom),
        } : raw;
        r.height = r.bottom - r.top;
        if (r.right - r.left > 0.5 && r.height > 0.5) boxes.push({ owner, layer, r });
      }
    }
    for (const el of document.body.querySelectorAll('input:not([type="hidden"]),select,textarea,button')) {
      if (ignored(el, ignore) || !shown(el) || parked(el)) continue;
      boxes.push({ owner: el, layer: layerOf(el), r: el.getBoundingClientRect() });
    }
    boxes.sort((a, b) => a.r.top - b.r.top);
    const hits = []; const pairs = new Set();
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      for (let j = i + 1; j < boxes.length && boxes[j].r.top < a.r.bottom; j++) {
        const b = boxes[j];
        if (a.owner === b.owner || a.layer !== b.layer) continue;
        if (a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 2 && iy > 2 && iy > 0.4 * Math.min(a.r.height, b.r.height)) {
          const key = describe(a.owner) + ' x ' + describe(b.owner);
          if (!pairs.has(key)) { pairs.add(key); hits.push(`${key} (${Math.round(ix)}x${Math.round(iy)}px)`); }
        }
      }
    }
    return hits;
  };

  /* touch targets */
  const targets = (ignore, min, root = document) => {
    const small = []; let measured = 0;
    for (const el of interactives(ignore, root)) {
      if (parked(el) || inlineInText(el)) continue;
      const r = el.getBoundingClientRect();
      let w = r.width; let h = r.height;
      if (el.labels) for (const l of el.labels) {
        const lr = l.getBoundingClientRect();
        w = Math.max(w, lr.width); h = Math.max(h, lr.height);
      }
      measured++;
      if (Math.min(w, h) < min - 0.5) small.push(`${describe(el)} ${Math.round(w)}x${Math.round(h)}`);
    }
    return { measured, small };
  };

  /* pointer reachability: scroll each control into view, hit-test the centre
     of each of its boxes (a link wrapped over two lines has two; the centre of
     their union can fall in the paragraph between them) */
  const pointer = (ignore) => {
    const covered = []; let tested = 0;
    for (const el of interactives(ignore)) {
      if (parked(el)) continue;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const boxes = [...el.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      if (!boxes.length) boxes.push(el.getBoundingClientRect());
      tested++;
      let hit = null; let ok = false;
      for (const r of boxes) {
        const x = Math.min(Math.max(r.left + r.width / 2, 0), vw() - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 0), vh() - 1);
        hit = document.elementFromPoint(x, y);
        ok = !!hit && (hit === el || el.contains(hit)
          || (el.labels && [...el.labels].some((l) => l.contains(hit)))
          || hit.closest('label')?.control === el);
        if (ok) break;
      }
      if (!ok) covered.push(`${describe(el)} under ${describe(hit)}`);
    }
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    return { tested, covered };
  };

  /* static a11y basics */
  const basics = () => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
    positiveTabindex: [...document.querySelectorAll('[tabindex]')]
      .filter((e) => Number(e.getAttribute('tabindex')) > 0).map(describe),
    noAlt: [...document.querySelectorAll('img')]
      .filter((i) => i.getAttribute('alt') === null && i.getAttribute('aria-hidden') !== 'true' && !i.closest('[aria-hidden="true"]'))
      .map((i) => i.getAttribute('src') || describe(i)),
  });

  /* keyboard walk support */
  // Focus styles are compared after normalising the invisible ones away: an
  // outline that is none, 0px wide or fully transparent is "none" (the common
  // `outline: 2px solid transparent` reset), and a box-shadow whose every layer
  // is transparent or has zero offset, blur and spread is "none".
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/\(([^)]*)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const a = c.startsWith('color(') ? (m[1].includes('/') ? parts[parts.length - 1] : '1') : parts[3];
    if (a === undefined) return 1;
    return a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
  };
  const outlineSig = (s) => (s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0 || alpha(s.outlineColor) === 0
    ? 'none' : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`);
  const shadowSig = (v) => {
    if (!v || v === 'none') return 'none';
    const layers = v.split(/,(?![^(]*\))/).map((l) => l.trim()).filter((l) => {
      const color = (l.match(/(rgba?|hsla?|color|lab|lch|oklab|oklch)\([^)]*\)/) || ['rgb(0,0,0)'])[0];
      const lengths = l.replace(color, '').match(/-?[\d.]+px/g) || [];
      return alpha(color) > 0 && lengths.some((n) => parseFloat(n) !== 0);
    });
    return layers.length ? layers.join(', ') : 'none';
  };
  const RAW_PROPS = ['backgroundColor', 'borderTopColor', 'borderBottomColor', 'color', 'textDecorationLine', 'transform'];
  const snap = (el) => {
    const parts = [];
    for (const [node, pseudo] of [[el, null], [el, '::before'], [el, '::after'], [el.parentElement, null]]) {
      if (!node) continue;
      const s = getComputedStyle(node, pseudo);
      parts.push([outlineSig(s), shadowSig(s.boxShadow), ...RAW_PROPS.map((p) => s[p])].join('|'));
    }
    return parts.join('#');
  };
  const walk = { list: [], base: [], parked: new Set() };
  // A first Tab stop counts as a skip link when it is an in-page #id link (not a
  // #/ or #! hash route) whose target exists, or one hidden until focused (then
  // a missing target is a broken skip link). A visible link to a missing
  // anchor is just a link: null means "not a skip link".
  const skipLink = (el, href) => {
    if (!/^#[^/!]/.test(href)) return null;
    const exists = !!document.getElementById(decodeURIComponent(href.slice(1)));
    if (exists) return true;
    return walk.parked.has(el) ? false : null;
  };
  const walkPrepare = (ignore) => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    walk.list = interactives(ignore).filter((el) => el.tabIndex >= 0);
    walk.base = walk.list.map(snap);
    walk.parked = new Set(walk.list.filter(parked));
    return walk.list.map(describe);
  };
  const focusStop = (ignore) => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { body: true };
    if (ignored(el, ignore)) return { ignored: true };
    const idx = walk.list.indexOf(el);
    const r = el.getBoundingClientRect();
    const visible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && r.width > 1 && r.height > 1;
    const onscreen = r.right > 0 && r.left < vw() && r.bottom > 0 && r.top < vh();
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    return {
      idx, desc: describe(el), visible, onscreen,
      indicator: idx >= 0 ? snap(el) !== walk.base[idx] : null,
      skipTarget: skipLink(el, href),
    };
  };

  /* overlays */
  const panelsNow = () => [...document.querySelectorAll(PANELS)].filter(shown);
  // A popup trigger: a non-link control that declares it opens something.
  // A submit control (or one bound to a form) is never auto-clicked: it would
  // submit, and a submit can delete.
  const submits = (el) => el.hasAttribute('form') || (!!el.form && (el.type === 'submit' || el.type === 'image'));
  const triggerEls = (ignore) => interactives(ignore).filter((el) =>
    el.tagName !== 'A' && !parked(el) && !submits(el) && (
      (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false')
      || el.getAttribute('aria-expanded') === 'false' || el.hasAttribute('popovertarget')
      || el.hasAttribute('commandfor')));
  const triggers = (ignore) => triggerEls(ignore).map(describe);
  // Remembers the trigger and the panels already open, returns the element to click.
  const markTrigger = (ignore, i) => {
    const el = triggerEls(ignore)[i] || null;
    walk.trigger = el;
    walk.before = new Set(panelsNow());
    if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return el;
  };
  // Explicit overlays: the configured opener is the trigger.
  const markOpener = (selector) => {
    walk.trigger = document.querySelector(selector);
    walk.before = new Set(panelsNow());
  };
  const findPanel = (selector) => {
    if (selector) { const p = document.querySelector(selector); return p && shown(p) ? p : null; }
    const ctl = walk.trigger?.getAttribute('aria-controls');
    if (ctl) { const p = document.getElementById(ctl); if (p && shown(p)) return p; }
    const fresh = panelsNow().filter((p) => !(walk.before || new Set()).has(p));
    return fresh[0] || null;
  };
  const measurePanel = (selector, ignore, min) => {
    const p = findPanel(selector);
    walk.panel = p;
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const pinned = inTopLayer(p);
    const fitsW = r.left >= -1 && r.right <= vw() + 1;
    const fitsH = !pinned || (r.top >= -1 && r.bottom <= vh() + 1);
    // Content taller than its box must be reachable: by a scroller inside the
    // panel, or (for an in-flow panel) by the page.
    const cut = [];
    let scroller = null;
    let spill = null;
    for (const el of [p, ...p.querySelectorAll('*')]) {
      if (!shown(el)) continue;
      const s = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
        if (SCROLLS.has(s.overflowY)) { scroller = scroller || el; continue; }
        if (CLIPS.has(s.overflowY)) cut.push(`${describe(el)} hides ${el.scrollHeight - el.clientHeight}px`);
      }
      if (pinned && el !== p && !spill) {
        const er = el.getBoundingClientRect();
        let inScroller = false;
        for (let a = el.parentElement; a && a !== p.parentElement; a = a.parentElement) {
          if (SCROLLS.has(getComputedStyle(a).overflowY)) { inScroller = true; break; }
        }
        if (!inScroller && (er.bottom > vh() + 1 || er.top < -1)) spill = el;
      }
    }
    if (spill) cut.push(`${describe(spill)} sits outside the ${vh()}px viewport with no scroller to reach it`);
    const t = targets(ignore, min, p);
    const c = clipped(ignore, p);
    return {
      desc: describe(p), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      vw: vw(), vh: vh(), pinned, fitsW, fitsH, cut,
      scroller: scroller ? `${describe(scroller)} scrolls ${scroller.scrollHeight}>${scroller.clientHeight}` : null,
      modal: p.matches(':modal') || p.getAttribute('aria-modal') === 'true',
      role: p.getAttribute('role') || p.tagName.toLowerCase(),
      focusInside: p.contains(document.activeElement),
      small: t.small, clippedText: c.cut,
    };
  };
  const panelFocus = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return 'outside-page';
    return walk.panel && walk.panel.contains(a) ? 'inside' : `behind: ${describe(a)}`;
  };
  const panelAfterEscape = () => ({
    open: !!walk.panel && walk.panel.isConnected && shown(walk.panel),
    focusBack: document.activeElement === walk.trigger,
    focusNow: describe(document.activeElement),
  });

  /* forms: is the failure announced? */
  const announced = () => {
    const live = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], output')]
      .map((e) => e.textContent.trim()).filter(Boolean);
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].map((f) => {
      const ids = `${f.getAttribute('aria-describedby') || ''} ${f.getAttribute('aria-errormessage') || ''}`.trim().split(/\s+/).filter(Boolean);
      return ids.map((id) => document.getElementById(id)?.textContent.trim() || '').join(' ').trim();
    }).filter(Boolean);
    const native = [...document.querySelectorAll('input, select, textarea')]
      .filter((f) => f.willValidate && !f.checkValidity()).map((f) => f.validationMessage);
    return { live, invalid, native };
  };

  const ignoresPage = (ignore) => ignore.filter((sel) => {
    try {
      return document.documentElement.matches(sel) || (document.body && document.body.matches(sel))
        || [...document.querySelectorAll('main')].some((m) => m.matches(sel));
    } catch { return false; }
  });

  window.__wa = {
    ignoresPage,
    hscroll, offscreen, clipped, overlap, targets, pointer, basics,
    walkPrepare, focusStop, triggers, markTrigger, markOpener, measurePanel, panelFocus, panelAfterEscape, announced,
  };
}

/* ─────────────────────────────── the run ─────────────────────────────── */

const TEXT_SPACING_CSS = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important;
  word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }`;

async function openPage(browser, width, height, dir) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: dir.locale,
    reducedMotion: 'reduce',
    hasTouch: true,
  });
  await context.addInitScript(installHelpers);
  // Smooth scrolling would leave focus and hit-test rects mid-animation.
  await context.addInitScript(() => {
    const add = () => {
      if (document.getElementById('__wa-scroll')) return;
      const st = document.createElement('style');
      st.id = '__wa-scroll';
      st.textContent = '*, html { scroll-behavior: auto !important; }';
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) add();
    document.addEventListener('DOMContentLoaded', add);
  });
  if (dir.localStorage) {
    await context.addInitScript((seed) => {
      try { for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v); } catch { /* storage blocked */ }
    }, dir.localStorage);
  }
  if (dir.forceDir) {
    await context.addInitScript((d) => {
      const set = () => document.documentElement && document.documentElement.setAttribute('dir', d);
      set(); document.addEventListener('DOMContentLoaded', set);
    }, dir.forceDir);
  }
  return { context, page: await context.newPage() };
}

const noHash = (u) => u.split('#')[0];

function routeUrl(cfg, route, dir) {
  const u = cfg.url + (route.startsWith('/') ? route : '/' + route);
  if (!dir.query) return u;
  return u + (u.includes('?') ? '&' : '?') + dir.query;
}

async function load(page, url, cfg) {
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(cfg.settleMs);
  return resp;
}

async function keyboardWalk(page, ignoreSel) {
  const expected = await page.evaluate((ig) => window.__wa.walkPrepare(ig), ignoreSel);
  const reached = new Set();
  const noIndicator = []; const offscreenFocus = []; const unknown = [];
  let first = null; let skip = null;
  const limit = Math.min(400, expected.length * 2 + 10);
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate((x) => window.__wa.focusStop(x), ignoreSel);
    if (s.body) { if (reached.size) break; continue; }
    if (s.ignored) continue;
    if (first === null) { first = s.desc; skip = s.skipTarget; }
    else if (s.idx >= 0 && reached.has(s.idx)) break;            // cycled
    if (s.idx >= 0) reached.add(s.idx); else unknown.push(s.desc);
    if (!s.visible || !s.onscreen) offscreenFocus.push(`${s.desc}${s.visible ? ' off-screen' : ' invisible'}`);
    if (s.indicator === false) noIndicator.push(s.desc);
  }
  const unreached = expected.filter((_, i) => !reached.has(i));
  return { expected, reached: reached.size, unreached, noIndicator, offscreenFocus, unknown, first, skip };
}

async function checkOverlay(page, cfg, where, label, selector, ignoreSel) {
  await page.waitForTimeout(300);
  const m = await page.evaluate(([s, ig, min]) => window.__wa.measurePanel(s, ig, min), [selector, ignoreSel, cfg.minTarget]);
  if (!m) {
    report('overlay-open', where, false, `${label}: nothing measurable opened (no dialog/menu/listbox/popover became visible)`, [], 'WARN');
    return;
  }
  const tag = `${label} -> ${m.desc}`;
  report('overlay-fit', where, m.fitsW && m.fitsH,
    `${tag} box ${m.rect[2]}x${m.rect[3]} at ${m.rect[0]},${m.rect[1]} in ${m.vw}x${m.vh}${m.pinned ? ' (pinned)' : ' (in flow)'}`);
  report('overlay-scroll', where, m.cut.length === 0,
    `${tag} ${m.scroller ? m.scroller : 'no inner scroller needed or found'}`, m.cut);
  report('overlay-target', where, m.small.length === 0, `${tag} targets >= ${cfg.minTarget}px`, m.small);
  report('overlay-clipped', where, m.clippedText.length === 0, `${tag} text clipped: ${m.clippedText.length}`, m.clippedText);
  const isDialog = /dialog/.test(m.role) || m.modal;
  if (isDialog) report('overlay-focus', where, m.focusInside, `${tag} focus moved inside on open: ${m.focusInside}`);
  await page.screenshot({ path: join(cfg.out, `${where.replace(/[^a-z0-9]+/gi, '_')}_${label.replace(/[^a-z0-9]+/gi, '_').slice(0, 30)}.png`) });
  if (m.modal) {
    let leak = null;
    for (let i = 0; i < 30 && !leak; i++) {
      await page.keyboard.press(i < 15 ? 'Tab' : 'Shift+Tab');
      const f = await page.evaluate(() => window.__wa.panelFocus());
      if (f.startsWith('behind')) leak = f;
    }
    report('overlay-trap', where, !leak, `${tag} focus stays out of the page behind for 15 Tab + 15 Shift+Tab${leak ? `: ${leak}` : ''}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const e = await page.evaluate(() => window.__wa.panelAfterEscape());
  report('overlay-escape', where, !e.open, `${tag} Escape closes it: ${!e.open}`);
  if (!e.open) report('overlay-return', where, e.focusBack, `${tag} focus returns to the trigger (now on ${e.focusNow})`);
}

async function runPage(browser, cfg, route, width, dir) {
  const where = `${route} ${width}px ${dir.name}`;
  console.log(`\n== ${where} ==`);
  const ig = cfg.ignore.map((i) => i.selector);
  const url = routeUrl(cfg, route, dir);
  const { context, page } = await openPage(browser, width, cfg.height, dir);
  try {
    let resp;
    try { resp = await load(page, url, cfg); } catch (e) {
      report('load', where, false, `${url} failed to load: ${e.message.split('\n')[0]}`);
      return;
    }
    const status = resp ? resp.status() : 0;
    const landed = page.url();
    report('load', where, !resp || status < 400,
      `${url} HTTP ${resp ? status : 'n/a (file)'}${noHash(landed) !== noHash(url) ? ` -> landed on ${landed}` : ''}`);
    const broad = await page.evaluate((x) => window.__wa.ignoresPage(x), ig);
    if (broad.length) die(`ignore selector(s) ${broad.join(', ')} match html, body or main: that ignores the page`);

    const shot = join(cfg.out, `${where.replace(/[^a-z0-9]+/gi, '_')}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`  shot   ${shot}`);

    const b = await page.evaluate(() => window.__wa.basics());
    report('lang', where, !!b.lang, `<html lang="${b.lang}">`);
    if (dir.expectDir) report('dir', where, b.dir === dir.expectDir, `direction ${b.dir}, expected ${dir.expectDir}`);
    report('tabindex', where, b.positiveTabindex.length === 0, `positive tabindex: ${b.positiveTabindex.length}`, b.positiveTabindex);
    report('alt', where, b.noAlt.length === 0, `<img> without alt: ${b.noAlt.length}`, b.noAlt);

    const h = await page.evaluate((x) => window.__wa.hscroll(x), ig);
    report('hscroll', where, h.scrollWidth <= h.clientWidth + 1,
      `scrollWidth ${h.scrollWidth} ${h.scrollWidth <= h.clientWidth + 1 ? '<=' : '>'} clientWidth ${h.clientWidth}`, h.offenders);

    const off = await page.evaluate((x) => window.__wa.offscreen(x), ig);
    report('offscreen', where, off.length === 0, `elements outside the ${width}px viewport: ${off.length}`, off);
    const c = await page.evaluate((x) => window.__wa.clipped(x), ig);
    report('clipped', where, c.cut.length === 0, `content clipped by an ancestor: ${c.cut.length}`, c.cut);
    report('truncated', where, c.truncated.length === 0, `text truncated by ellipsis/line-clamp: ${c.truncated.length} (read the screenshot)`, c.truncated, 'WARN');
    const o = await page.evaluate((x) => window.__wa.overlap(x), ig);
    report('overlap', where, o.length === 0, `overlapping text/control pairs: ${o.length}`, o);

    const t = await page.evaluate(([x, m]) => window.__wa.targets(x, m), [ig, cfg.minTarget]);
    report('target', where, t.small.length === 0, `${t.measured} targets, under ${cfg.minTarget}px: ${t.small.length}`, t.small);

    const p = await page.evaluate((x) => window.__wa.pointer(x), ig);
    report('pointer', where, p.covered.length === 0, `${p.tested} controls hit-tested, covered: ${p.covered.length}`, p.covered);

    const k = await keyboardWalk(page, ig);
    report('keyboard', where, k.unreached.length === 0, `Tab reached ${k.reached}/${k.expected.length} controls`, k.unreached);
    report('focus-visible', where, k.noIndicator.length === 0, `focus stops with no visible style change: ${k.noIndicator.length}`, k.noIndicator);
    report('focus-onscreen', where, k.offscreenFocus.length === 0, `focus landed off-screen or invisible: ${k.offscreenFocus.length}`, k.offscreenFocus);
    if (k.unknown.length) console.log(`  note   Tab also stopped on ${k.unknown.length} element(s) outside the measured set (no focus-style baseline): ${k.unknown.slice(0, 3).join(' ; ')}`);
    if (k.skip === null) report('skip-link', where, false, `first Tab lands on ${k.first || 'nothing'}, not an in-page skip link`, [], 'WARN');
    else report('skip-link', where, k.skip, `first Tab is a skip link (${k.first}); target exists: ${k.skip}`);

    await load(page, url, cfg);
    await page.addStyleTag({ content: TEXT_SPACING_CSS });
    await page.waitForTimeout(cfg.settleMs);
    const hs = await page.evaluate((x) => window.__wa.hscroll(x), ig);
    const cs = await page.evaluate((x) => window.__wa.clipped(x), ig);
    report('text-spacing', where, hs.scrollWidth <= hs.clientWidth + 1 && cs.cut.length === 0,
      `WCAG 1.4.12 override: scrollWidth ${hs.scrollWidth} vs ${hs.clientWidth}, clipped ${cs.cut.length}`, [...hs.offenders, ...cs.cut]);

    // Axis 3: explicit overlays first, then every popup trigger found on the page.
    for (const ov of cfg.overlays.filter((x) => !x.route || x.route === route)) {
      await load(page, url, cfg);
      await page.evaluate((s) => window.__wa.markOpener(s), ov.open);
      try { await page.click(ov.open, { timeout: 5000 }); } catch (e) {
        report('overlay-open', where, false, `cannot click ${ov.open}: ${e.message.split('\n')[0]}`);
        continue;
      }
      await checkOverlay(page, cfg, where, ov.open, ov.panel || null, ig);
    }
    if (cfg.autoOverlays) {
      await load(page, url, cfg);
      const trig = await page.evaluate((x) => window.__wa.triggers(x), ig);
      for (let i = 0; i < Math.min(trig.length, cfg.maxTriggers); i++) {
        await load(page, url, cfg);
        const home = noHash(page.url());
        const marked = (await page.evaluateHandle(([x, n]) => window.__wa.markTrigger(x, n), [ig, i])).asElement();
        if (!marked) continue;
        const d = trig[i];
        try { await marked.click({ timeout: 5000 }); } catch (e) {
          report('overlay-open', where, false, `cannot click trigger ${d}: ${e.message.split('\n')[0]}`);
          continue;
        }
        if (noHash(page.url()) !== home) { report('overlay-open', where, false, `trigger ${d} navigated away to ${page.url()}`, [], 'WARN'); continue; }
        await checkOverlay(page, cfg, where, d, null, ig);
      }
      if (trig.length > cfg.maxTriggers) console.log(`  note   ${trig.length - cfg.maxTriggers} more popup triggers not opened (maxTriggers ${cfg.maxTriggers})`);
    }

    // Announced errors: only where a form scenario is configured.
    for (const f of cfg.forms.filter((x) => x.route === route)) {
      await load(page, url, cfg);
      for (const [sel, val] of Object.entries(f.fill || {})) await page.fill(sel, val);
      await page.click(f.submit);
      await page.waitForTimeout(f.waitMs || 1500);
      const a = await page.evaluate(() => window.__wa.announced());
      const ok = a.live.length > 0 || a.invalid.length > 0 || a.native.length > 0;
      report('form-error', where, ok, `${f.submit}: live ${a.live.length}, aria-invalid described ${a.invalid.length}, native ${a.native.length}`,
        [...a.live, ...a.invalid, ...a.native].map((s) => `"${s.slice(0, 40)}"`));
    }
  } finally {
    await context.close();
  }
}

const cfg = loadConfig();
cfgRef = cfg;
const { chromium } = loadPlaywright();
mkdirSync(cfg.out, { recursive: true });
console.log(`screenshots: ${cfg.out}`);
let browser;
try { browser = await chromium.launch(); } catch (e) { die(`Chromium failed to launch: ${e.message.split('\n')[0]}`); }
try {
  for (const route of cfg.routes) for (const width of cfg.widths) for (const dir of cfg.directions) {
    try { await runPage(browser, cfg, route, width, dir); } catch (e) {
      report('run', `${route} ${width}px ${dir.name}`, false, `check crashed: ${e.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
}
if (cfg.json) writeFileSync(cfg.json, JSON.stringify(results, null, 2));
const warns = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}${warns ? ` (${warns} warning(s))` : ''} — screenshots in ${cfg.out}`);
process.exit(failures === 0 ? 0 : 1);
