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
 * This is the visual twin of hardcode-check.mjs (which guards user-visible
 * STRINGS), and it scans EVERY tree in its config at once (default `src/` and
 * `web/src/`): a second app directory scanned by nothing is exactly how a web
 * app ships with zero media queries and raw backend errors on five screens.
 *
 * SUPPRESSION: `// design-ok(<class>): reason` on the line or the line above
 * (CSS: `/* design-ok(<class>): reason *\/`). Reasons are reviewed like code.
 *
 * Exit 1 on any NEW FAIL-class finding. WARN classes are advisory and exit 0.
 *
 * Usage: node design-check.mjs                  check (run from the repo root)
 *        node design-check.mjs --update         restamp: drop fixed rows, never add one
 *        node design-check.mjs --seed           create the baseline once, on adoption,
 *                                               in $GATE_STATE_DIR (set by the gates runner)
 *        node design-check.mjs --seed --in-repo create it as .claude/design-baseline.json
 *                                               instead, for a repo that carries its own bar
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/* ── per-project config ──────────────────────────────────────────────────────
   Project specifics (where tokens live, which trees to scan) live in JSON, never
   in this script. A repo-committed `.claude/gate-config.json` wins (a repo that
   carries its own bar); else `$GATE_STATE_DIR/gate-config.json` (the external
   runner's per-repo state, so nothing is written into the project). Each gate
   reads only its own section. An unknown or mistyped key is an ERROR: a typo
   would otherwise switch a check off without a word. */
/* COUPLING: hardcode-check.mjs, i18n-check.mjs and design-check.mjs each carry
   an identical copy of loadGateConfig and KNOWN_SECTIONS (the scripts must stay
   copyable one by one). A new section or a loader change moves all three. */
const KNOWN_SECTIONS = ['hardcode', 'i18n', 'design'];

function loadGateConfig(section, schema) {
  const paths = ['.claude/gate-config.json'];
  if (process.env.GATE_STATE_DIR) paths.push(join(process.env.GATE_STATE_DIR, 'gate-config.json'));
  const path = paths.find((p) => existsSync(p));
  if (!path) return { path: null, cfg: {} };
  const die = (why) => { console.error(`✖ ${path} [${section}]: ${why}`); process.exit(2); };
  const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const raw = readFileSync(path, 'utf8');
  let all;
  try { all = JSON.parse(raw); } catch (e) { die(`unreadable JSON — ${e.message}`); }
  if (!isPlainObj(all)) die('the top level must be an object of sections');
  // JSON.parse keeps the LAST of two same-named sections, silently dropping the
  // first. Walk the raw text and collect the keys at depth 1 to catch that.
  const topKeys = [];
  for (let i = 0, depth = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(raw.slice(j + 1))) topKeys.push(JSON.parse(raw.slice(i, j + 1)));
      i = j;
    }
  }
  const dup = topKeys.find((k, n) => KNOWN_SECTIONS.includes(k) && topKeys.indexOf(k) !== n);
  if (dup !== undefined) die(`section "${dup}" appears more than once (JSON keeps only the last)`);
  // A misspelt section ("hardcod") would otherwise leave every check it
  // configures silently OFF and the run green.
  for (const name of Object.keys(all)) {
    if (!name.startsWith('//') && !KNOWN_SECTIONS.includes(name)) {
      die(`unknown section "${name}" (known: ${KNOWN_SECTIONS.join(', ')})`);
    }
  }
  const cfg = Object.hasOwn(all, section) ? all[section] : {};
  if (!isPlainObj(cfg)) die(`section "${section}" must be an object`);
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('//')) continue;
    if (!Object.hasOwn(schema, k)) die(`unknown key "${k}" (known: ${Object.keys(schema).join(', ')})`);
    if (!schema[k](v)) die(`key "${k}" has the wrong shape`);
  }
  return { path, cfg };
}
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

const { cfg: CONFIG } = loadGateConfig('design', {
  tokenFiles: isStrList,   // single files allowed to DEFINE visual values
  tokenDirs: isStrList,    // whole trees allowed to (token CSS, a vendored design system)
  mediaAllowed: isStrList, // the one stylesheet that holds the width breakpoints
  scan: (v) => Array.isArray(v) && v.length > 0 && v.every((t) => t && typeof t.dir === 'string' && isStrList(t.exts)),
});

/* A configured scan tree that is missing, or that scans nothing, would leave a
   whole surface unchecked behind a green run — the perimeter failure. */
for (const { dir, exts } of CONFIG.scan ?? []) {
  const bad = !existsSync(dir) ? `scan dir "${dir}" does not exist`
    : exts.length === 0 ? `scan dir "${dir}" lists no extensions`
    : exts.find((e) => !/^\.[\w.]+$/.test(e)) ? `scan dir "${dir}" has an extension not starting with "." (${exts.join(', ')})`
    : null;
  if (bad) { console.error(`✖ gate-config.json [design]: ${bad}`); process.exit(2); }
}

const ROOT = process.cwd();

/* ── Where a visual value is ALLOWED to be defined ──────────────────────────
   These are the single locations. Everything else references them. The
   defaults fit an Expo app beside a web app; a project overrides them in
   gate-config.json `design`. */
const TOKEN_FILES = CONFIG.tokenFiles ?? ['src/constants/theme.ts'];
const TOKEN_DIRS = CONFIG.tokenDirs ?? ['web/src/styles/tokens', 'web/src/ds'];
/** Breakpoints live in ONE stylesheet so each literal appears once. */
const MEDIA_ALLOWED = CONFIG.mediaAllowed ?? ['web/src/styles/layout.css'];

const SCAN = CONFIG.scan ?? [
  { dir: 'src', exts: ['.ts', '.tsx'] },
  { dir: 'web/src', exts: ['.ts', '.tsx', '.css'] },
];
/** Web-only rules (media queries) apply to trees that scan .css. */
const WEB_DIRS = SCAN.filter((t) => t.exts.includes('.css')).map((t) => t.dir);
const inWebTree = (r) => WEB_DIRS.some((d) => r.startsWith(`${d}/`));

/* ── THE RATCHET (see ../ratchet.md) ─────────────────────────────────────────
   A gate introduced onto a live codebase finds a backlog it did not cause, and
   a gate that blocks unrelated work gets bypassed — which is worse than no
   gate. So the violations that EXISTED when this was seeded are baselined, and
   anything NEW fails. The baseline may only shrink: `--update` refuses to grow
   it, and only `--seed` may create it, once.
   Keyed on file + rule + the offending text, NOT the line number, so moving
   code around does not manufacture a "new" violation. The key is a MULTISET:
   a baselined line pasted a second time in the same file is a NEW finding,
   never a free copy of the old one.

   Where the baseline lives, first match wins (the same precedence the external
   runner uses for conventions.json):
     1. `.claude/design-baseline.json` committed in the repo — a repo that
        carries its own bar;
     2. `$GATE_STATE_DIR/design-baseline.json` — the external runner's state,
        keyed by repo path, so NOTHING is written into a repo you do not own;
     3. neither exists: `--seed` creates (2) when GATE_STATE_DIR is set, else (1). */
const STATE_DIR = process.env.GATE_STATE_DIR ?? null;
const REPO_BASELINE = join(ROOT, '.claude', 'design-baseline.json');
const STATE_BASELINE = STATE_DIR ? join(STATE_DIR, 'design-baseline.json') : null;
/* COUPLING: ~/.claude/bin/gates derives its per-repo state dir with this same
   slug (strip the leading '/', every non-alphanumeric → '_'). When this runs
   WITHOUT GATE_STATE_DIR, a baseline the runner keeps there is still invisible
   to the precedence above — so a repo seed would shadow it. Change both or
   neither. */
const DEFAULT_STATE_BASELINE = join(homedir(), '.claude', 'gate-state',
  ROOT.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '_'), 'design-baseline.json');
const BASELINE_FILE = existsSync(REPO_BASELINE) || !STATE_DIR ? REPO_BASELINE : STATE_BASELINE;
const BASELINE_EXISTS = existsSync(BASELINE_FILE);
/** A malformed baseline is a clean exit 2, never a stack trace. */
function readBaseline(file) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`✖ ${file}: unreadable JSON — ${e.message}`);
    process.exit(2);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    console.error(`✖ ${file}: must be an object with a "known" list`);
    process.exit(2);
  }
  const known = doc.known ?? [];
  if (!Array.isArray(known) || !known.every((k) => typeof k === 'string')) {
    console.error(`✖ ${file}: "known" must be a list of strings`);
    process.exit(2);
  }
  return { note: typeof doc['//'] === 'string' ? doc['//'] : null, known };
}
const { note: baselineNote, known: baselineList } = BASELINE_EXISTS
  ? readBaseline(BASELINE_FILE)
  : { note: null, known: [] };
const keyOf = (f) => `${f.file}::${f.rule.id}::${f.text}`;

/** key → how many times it may occur. */
function countKeys(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

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
      `one definition — see ${[...TOKEN_FILES, ...TOKEN_DIRS.map((d) => `${d}/`)].join(' or ')}. ` +
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
    only: inWebTree,
    allow: MEDIA_ALLOWED,
    why:
      'every breakpoint literal must appear exactly once. Media queries belong in ' +
      `${MEDIA_ALLOWED.join(' / ')} so a breakpoint can be changed in one place.`,
  },
  {
    id: 'raw-breakpoint',
    fail: false, // advisory: a px width can be legitimate geometry
    re: /\b(?:min|max)-width:\s*\d+px/g,
    only: (r) => inWebTree(r) && !MEDIA_ALLOWED.includes(r),
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
const allowance = countKeys(baselineList);
const fresh = [];
const carriedList = [];
for (const f of findings) {
  const k = keyOf(f);
  const left = allowance.get(k) ?? 0;
  if (left > 0) { allowance.set(k, left - 1); carriedList.push(f); } else fresh.push(f);
}
const carried = carriedList.length;
/** Baseline rows whose violation is gone. Harmless today, but each one would
 *  silently re-admit that exact line if it came back — `--update` drops them. */
const stale = [...allowance.values()].reduce((n, c) => n + c, 0);
const writeBaseline = (known, note) => {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify({ '//': note, known: known.sort() }, null, 2) + '\n');
};

if (process.argv.includes('--seed')) {
  // Either baseline blocks a seed: a new repo baseline would SHADOW a state
  // one (the repo file wins), re-admitting everything the state one had burned.
  const existing = [REPO_BASELINE, STATE_BASELINE].filter((f) => f && existsSync(f));
  if (existing.length) {
    console.error(`\nREFUSED: a baseline already exists (${existing.join(', ')}). --seed runs once, on adoption;\n` +
      'after that the baseline only shrinks (--update). Deleting the file to re-seed is the bypass this refuses.\n');
    process.exit(1);
  }
  if (!STATE_DIR && existsSync(DEFAULT_STATE_BASELINE)) {
    console.error(`\nREFUSED: the gates runner already keeps a baseline for this repo at ${DEFAULT_STATE_BASELINE}.\n` +
      'A repo seed would shadow it and re-admit everything it burned down. To move the bar into the repo,\n' +
      `copy that file instead:  cp ${DEFAULT_STATE_BASELINE} .claude/design-baseline.json\n`);
    process.exit(1);
  }
  if (!STATE_DIR && !process.argv.includes('--in-repo')) {
    console.error('\nREFUSED: this writes a repo baseline that shadows any gate-state baseline; use gates --seed\n' +
      '(or pass --in-repo for a repo that deliberately carries its own baseline).\n');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  writeBaseline(findings.map(keyOf), `Frozen design-token backlog, seeded ${today}. May only SHRINK.`);
  console.log(`\nbaseline SEEDED with ${findings.length} pre-existing finding(s) at ${BASELINE_FILE}. New ones now fail.\n`);
  process.exit(0);
}

if (process.argv.includes('--update')) {
  if (!BASELINE_EXISTS) {
    console.error('\nREFUSED: no baseline to restamp. --update only ever SHRINKS a baseline; adopting the\n' +
      'gate on an existing backlog is a deliberate, separate step: --seed.\n');
    process.exit(1);
  }
  // A new FAIL finding blocks the restamp. A new WARN finding does not, and is
  // not written either: it stays visible as advisory output.
  const blocking = fresh.filter((f) => f.rule.fail);
  if (blocking.length) {
    console.error(
      `\nREFUSED: --update would GROW the baseline — ${blocking.length} finding(s) are not on it.\n` +
        'The ratchet only tightens. Fix the new findings instead of baselining them.\n',
    );
    for (const f of blocking.slice(0, 25)) console.error(`   - ${f.file}:${f.line}  ${f.rule.id}  ${f.text}`);
    process.exit(1);
  }
  writeBaseline(carriedList.map(keyOf), baselineNote ?? 'Frozen design-token backlog. May only SHRINK.');
  console.log(`\nbaseline tightened: ${baselineList.length} → ${carried}\n`);
  process.exit(0);
}

/* ── Report ───────────────────────────────────────────────────────────────── */
console.log(
  `\ndesign check — scanned ${scanned} file(s) in ${SCAN.map((t) => `${t.dir}/`).join(' and ')}` +
    (suppressed ? ` (${suppressed} suppressed via design-ok)` : ''),
);
// The backlog count prints on EVERY run, failing ones included — a number
// nobody sees never goes down.
if (BASELINE_EXISTS) {
  console.log(`ℹ  ${carried} finding(s) on the frozen backlog (${baselineList.length} row(s) in ${BASELINE_FILE})`);
}

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
    '\n✓ no NEW hardcoded visual values' +
      (carried ? ' (pay the backlog down, then --update)' : '') +
      '\n',
  );
}
if (stale) {
  console.log(`⚠  ${stale} STALE baseline row(s) — their violation is gone. Run --update to drop them,\n` +
    '   or each would silently re-admit its exact line if it came back.\n');
}
if (failed) {
  console.log(
    '\nOne definition per value. Reference the token, or suppress with a written' +
      '\nreason: // design-ok(<class>): why this literal is correct here.\n',
  );
}
process.exit(failed ? 1 : 0);
