#!/usr/bin/env node
/**
 * design-check — ONE SOURCE OF TRUTH FOR EVERY VISUAL VALUE.
 *
 * Owner directive, 2026-08-30: "Make sure no css and visual logic and code is
 * hard coded every thing should follow the control from a single location."
 *
 * WHY THIS IS A GATE AND NOT A GUIDELINE. The amber contrast failure that
 * produced 102 serious WCAG violations was ONE value used in many places.
 * Because it lived in a token, the fix is one edit. Pasted into thirty
 * components it would have been thirty edits, and the thirty-first would have
 * been missed — with no way to know which surfaces were still failing. Single
 * source is what makes a design problem, or a legal one, tractable at all.
 *
 * This is the visual twin of scripts/hardcode-check.mjs (which guards
 * user-visible STRINGS), and it deliberately covers `web/` as well as `src/` —
 * every other gate in this repo walks `src/` only, which is exactly how the web
 * app shipped with zero media queries and raw backend errors on five screens.
 *
 * SUPPRESSION: `// design-ok(<class>): reason` on the line or the line above
 * (CSS: `/* design-ok(<class>): reason *\/`). Reasons are reviewed like code.
 *
 * Exit 1 on any FAIL-class finding. WARN classes are advisory and exit 0.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/* ── THE RATCHET ────────────────────────────────────────────────────────────
   Same shape as hardcode-check's frozen legacy list, and for the same reason: a
   gate introduced onto a live codebase finds a backlog it did not cause, and a
   gate that blocks unrelated work gets bypassed — which is worse than no gate.
   So the violations that EXISTED when this was written are baselined, and
   anything NEW fails. The baseline may only shrink: `--update` refuses to grow
   it, so the backlog can be paid down but never quietly added to.
   Keyed on file + the offending text, NOT the line number, so moving code
   around does not manufacture a "new" violation. */
/* The baseline may live OUTSIDE the repo. When GATE_STATE_DIR is set (the
   external runner sets it, keyed by repo path), state is kept there and NOTHING
   is written into the project — so the gates can be run against a repo you do
   not own, or must not add tooling to, without leaving a trace in its tree. */
const STATE_DIR = process.env.GATE_STATE_DIR ?? null;
const BASELINE_FILE = STATE_DIR
  ? join(STATE_DIR, 'design-baseline.json')
  : '.claude/design-baseline.json';
const baseline = new Set(
  existsSync(STATE_DIR ? BASELINE_FILE : join(ROOT_DIR(), BASELINE_FILE))
    ? JSON.parse(readFileSync(STATE_DIR ? BASELINE_FILE : join(ROOT_DIR(), BASELINE_FILE), 'utf8')).known ?? []
    : [],
);
function ROOT_DIR() { return process.cwd(); }
const keyOf = (f) => `${f.file}::${f.rule.id}::${f.text}`;

const ROOT = process.cwd();

/* ── Where a visual value is ALLOWED to be defined ──────────────────────────
   These are the single locations. Everything else references them. */
const TOKEN_FILES = [
  'src/constants/theme.ts',      // app: 3 themes x light/dark
];
const TOKEN_DIRS = [
  'web/src/styles/tokens',       // web: the CSS custom properties
  'web/src/ds',                  // vendored design-system build (not ours to edit)
];
/** Breakpoints live in ONE stylesheet so each literal appears once. */
const MEDIA_ALLOWED = ['web/src/styles/layout.css'];

const SCAN = [
  { dir: 'src', exts: ['.ts', '.tsx'] },
  { dir: 'web/src', exts: ['.ts', '.tsx', '.css'] },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.expo', 'build', 'coverage']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
const isTokenFile = (r) =>
  TOKEN_FILES.includes(r) || TOKEN_DIRS.some((d) => r.startsWith(d + '/'));

/* ── The classes ──────────────────────────────────────────────────────────── */
const RULES = [
  {
    id: 'raw-color',
    fail: true,
    // #abc / #aabbcc / #aabbccdd, and rgb()/rgba()/hsl()/hsla()
    re: /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/g,
    why:
      'a colour literal outside the token files forks the design system. One value, ' +
      'one definition — see src/constants/theme.ts or web/src/styles/tokens/. ' +
      'Glyphs drawn over a user PHOTO are the sanctioned exception (a photo looks ' +
      'the same in both themes): suppress with a reason.',
  },
  {
    id: 'stray-media',
    fail: true,
    /* WIDTH queries only. `prefers-reduced-motion`, `prefers-contrast` and
       `forced-colors` are FEATURE queries — they belong wherever the behaviour
       they guard lives (a motion rule belongs beside the animation), and
       centralising them would be worse, not better. A FAIL class has to be
       calibrated to zero false positives or it teaches people to ignore it. */
    re: /@media[^{]*\b(?:min|max)-width\s*:/g,
    only: (r) => r.startsWith('web/'),
    allow: MEDIA_ALLOWED,
    why:
      'every breakpoint literal must appear exactly once. Media queries belong in ' +
      'web/src/styles/layout.css so a breakpoint can be changed in one place.',
  },
  {
    id: 'raw-breakpoint',
    fail: false, // advisory: a px width can be legitimate geometry
    re: /\b(?:min|max)-width:\s*\d+px/g,
    only: (r) => r.startsWith('web/') && !MEDIA_ALLOWED.includes(r),
    why: 'breakpoint literal outside the layout stylesheet — should reference a token.',
  },
];

/* ── Scan ─────────────────────────────────────────────────────────────────── */
const findings = [];
let scanned = 0;
let suppressed = 0;

for (const { dir, exts } of SCAN) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (!exts.some((e) => file.endsWith(e))) continue;
    const r = rel(file);
    if (isTokenFile(r)) continue;
    scanned += 1;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    for (const rule of RULES) {
      if (rule.only && !rule.only(r)) continue;
      if (rule.allow && rule.allow.includes(r)) continue;
      lines.forEach((line, i) => {
        rule.re.lastIndex = 0;
        if (!rule.re.test(line)) return;
        // Suppression on this line or the one above.
        const tag = `design-ok(${rule.id})`;
        if (line.includes(tag) || (i > 0 && lines[i - 1].includes(tag))) {
          suppressed += 1;
          return;
        }
        findings.push({ file: r, line: i + 1, rule, text: line.trim().slice(0, 110) });
      });
    }
  }
}

/* ── Ratchet ──────────────────────────────────────────────────────────────── */
const fresh = findings.filter((f) => !baseline.has(keyOf(f)));
const carried = findings.length - fresh.length;

if (process.argv.includes('--update')) {
  const now = findings.map(keyOf);
  const seeding = !existsSync(join(ROOT, BASELINE_FILE));
  if (seeding) {
    writeFileSync(
      join(ROOT, BASELINE_FILE),
      JSON.stringify(
        { '//': 'Frozen design-token backlog, seeded 2026-08-30. May only SHRINK.', known: now },
        null, 2,
      ) + '\n',
    );
    console.log(`\nbaseline SEEDED with ${now.length} pre-existing finding(s). New ones now fail.\n`);
    process.exit(0);
  }
  const shrunk = [...baseline].filter((k) => now.includes(k));
  if (now.length > shrunk.length) {
    console.error(
      `\nREFUSED: --update would GROW the baseline from ${baseline.size} to ${now.length}.\n` +
        'The ratchet only tightens. Fix the new findings instead of baselining them.\n',
    );
    process.exit(1);
  }
  writeFileSync(
    join(ROOT, BASELINE_FILE),
    JSON.stringify({ '//': 'Frozen design-token backlog. May only shrink.', known: shrunk }, null, 2) + '\n',
  );
  console.log(`\nbaseline tightened: ${baseline.size} → ${shrunk.length}\n`);
  process.exit(0);
}

/* ── Report ───────────────────────────────────────────────────────────────── */
console.log(
  `\ndesign check — scanned ${scanned} file(s) in src/ and web/src/` +
    (suppressed ? ` (${suppressed} suppressed via design-ok)` : ''),
);

const byRule = new Map();
for (const f of fresh) {
  if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, []);
  byRule.get(f.rule.id).push(f);
}

let failed = false;
for (const rule of RULES) {
  const hits = byRule.get(rule.id) ?? [];
  if (hits.length === 0) continue;
  const mark = rule.fail ? '✗' : '⚠';
  if (rule.fail) failed = true;
  console.log(`\n${mark}  ${hits.length} ${rule.id}`);
  console.log(`   ${rule.why}`);
  for (const h of hits.slice(0, 25)) console.log(`   - ${h.file}:${h.line}  ${h.text}`);
  if (hits.length > 25) console.log(`   … and ${hits.length - 25} more`);
}

if (!failed) {
  console.log(
    `\n✓ no NEW hardcoded visual values` +
      (carried ? ` (${carried} on the frozen backlog — pay down with --update)` : '') +
      '\n',
  );
} else {
  console.log(
    '\nOne definition per value. Reference the token, or suppress with a written' +
      '\nreason: // design-ok(<class>): why this literal is correct here.\n',
  );
}
process.exit(failed ? 1 : 0);
