#!/usr/bin/env node
/**
 * filemap-check — every path the cross-file traps index cites must exist.
 *
 * The thin FILEMAP (see the `filemap` skill) is an INDEX, not a description:
 * each line names two or more files that must move together, and the invariant
 * itself lives as a comment at both binding sites. The one thing such an index
 * can rot by mechanically is a cited path dying in a rename or a delete — the
 * line then points a reader at nothing, and the coupling it guarded is
 * forgotten. That is the only thing this checks. No hashes, no staleness
 * stamps, no --update: a restamp is how a stale description gets laundered
 * into a fresh one, which is the failure the thin model exists to end.
 *
 * WHAT COUNTS AS A CITED PATH. Only inline code spans outside fenced blocks.
 * A whole span that names an existing path is one citation, spaces and all
 * (`assets/App Icon.png`). Otherwise the span is split on whitespace and
 * commas (so `src/a.ts, src/b.ts` is two citations) after dropping a trailing
 * parenthetical (`src/a.ts (line 4)`). Backslashes read as `/`. Each piece is
 * checked when it is shaped like a repo-relative path:
 *   - it contains a `/` and its first segment exists at the repo root
 *     (`src/hooks`, `src/a.ts`, `scripts/`); or
 *   - it contains a `/`, its first segment is a dotdir, and it names a file or
 *     ends in `/` (`.claude/FILEMAP.md`, `.github/workflows/`); or
 *   - it has no `/`, does not start with `.`, and ends in a known source
 *     extension (`package.json`) — such a name is checked AT THE ROOT, so a
 *     bare basename like `theme.ts` fails: cite the full repo-relative path; or
 *   - it starts with `./`, which anchors anything at the root (`./.env`,
 *     `./Makefile`).
 * Everything else is prose to this gate: globs, URLs with or without a scheme
 * (`example.com/x.html`), package specifiers (`@scope/pkg/sub.js`,
 * `some-pkg/lib/x.js`), ratios and abbreviations (`0.5/1.0`, `e.g/i.e`), and
 * `~` `$` `<` `/` `..` forms, which are not repo-relative, and anything under
 * `node_modules/`, whose existence is install state, not repo state. A trailing line
 * reference (`:12`, `:12-40`, `:L12-L20`, `#L12`) is stripped first.
 * Brackets and parentheses inside a path are kept: `app/[id].tsx` and
 * `app/(tabs)/index.tsx` are real route paths.
 *
 * NOT CHECKED, by design (each would cost a false positive elsewhere): bare
 * root dotfiles (`.env`) and extensionless root files (`Makefile`) — cite them
 * as `./.env` and `./Makefile` to have them checked — and a path whose whole
 * top-level directory is gone (`old-app/x.ts` after `old-app/` is deleted
 * reads exactly like a package specifier).
 *
 * Suppress a sanctioned citation (an example path, a file that is generated at
 * build time) with `<!-- filemap-ok: reason -->` on the line or the line above.
 * A tag with no reason does not suppress.
 *
 * ROOT. With no argument the map is the first `.claude/FILEMAP.md` found
 * walking up from the CWD, so a run from a subdirectory checks the real map.
 * When the map path ends in `.claude/FILEMAP.md` the repo root is the map's
 * grandparent, so the check gives the same answer from any directory. Any
 * other map path resolves cited paths against the CWD.
 *
 * Exits 0 with one line when no argument is given and no map is found, so it
 * is safe in the verify chain of a project that keeps no FILEMAP. A map path
 * given explicitly that does not exist is an error: exit 1.
 *
 * Usage: node scripts/filemap-check.mjs [map=.claude/FILEMAP.md]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const DEFAULT_MAP = join('.claude', 'FILEMAP.md');
const EXPLICIT = process.argv[2] !== undefined;
const MAP = EXPLICIT ? process.argv[2] : findMapUpward() ?? DEFAULT_MAP;

/** The nearest `.claude/FILEMAP.md` at or above the CWD, as a CWD-relative path. */
function findMapUpward() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, DEFAULT_MAP);
    if (existsSync(candidate)) return relative(process.cwd(), candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** Extensions that make a slash-less name a file citation rather than prose. */
const ROOT_EXTS = new Set([
  'c', 'cc', 'cjs', 'conf', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'ini',
  'java', 'js', 'json', 'jsx', 'kt', 'lock', 'lua', 'md', 'mjs', 'php', 'py',
  'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx',
  'txt', 'vue', 'yaml', 'yml',
]);

if (!existsSync(MAP)) {
  if (EXPLICIT) {
    console.error(`\nfilemap check — ${MAP} does not exist\n`);
    process.exit(1);
  }
  console.log(`\nfilemap check — no ${MAP}, nothing cited\n`);
  process.exit(0);
}

const ROOT = /(^|[\\/])\.claude[\\/]FILEMAP\.md$/.test(MAP)
  ? dirname(dirname(resolve(MAP)))
  : process.cwd();
const atRoot = (p) => existsSync(join(ROOT, p));

/** A piece of a span reduced to the repo-relative path it cites, or null. */
function citedPath(piece) {
  const slashed = piece.replace(/\\/g, '/');
  const anchored = slashed.startsWith('./');
  const p = slashed
    .replace(/#L\d+(?:-L?\d+)?$/, '')
    .replace(/:L?\d+(?:[-:]L?\d+)?$/, '')
    .replace(/^\.\//, '');
  if (!p || /[*?{}:]/.test(p) || /^([~$</@]|\.\.)/.test(p)) return null;
  if (p.split('/').includes('node_modules')) return null;

  if (!p.includes('/')) {
    if (anchored) return p;
    if (p.startsWith('.')) return null;
    const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
    return ROOT_EXTS.has(ext) ? p : null;
  }
  const segments = p.split('/');
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (atRoot(first)) return p;
  if (first.startsWith('.') && (last === '' || /\.[A-Za-z0-9]{1,10}$/.test(last))) return p;
  return null;
}

/** The paths one inline code span cites. */
function citedPaths(span) {
  const whole = citedPath(span);
  if (whole !== null && atRoot(whole)) return [whole];
  return span
    .replace(/\s+\([^()]*\)\s*$/, '')
    .split(/[\s,]+/)
    .map(citedPath)
    .filter((p) => p !== null);
}

function suppressed(lines, i) {
  const tag = /filemap-ok:\s*[^\s>-]/;
  return tag.test(lines[i]) || (i > 0 && tag.test(lines[i - 1]));
}

const lines = readFileSync(MAP, 'utf8').split(/\r?\n/);
const dead = new Map(); // path -> map line numbers citing it
let cited = 0;
let suppressedCount = 0;
let fence = null; // the opening run, e.g. '````', while inside a fenced block

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // A fence closes only on a run of the SAME character at least as long as its
  // opener, alone on its line — so a ``` inside a ```` block is content, not a
  // close. Any indent is accepted, so a fence nested under a list item counts.
  const run = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (fence === null) {
    if (run) { fence = run[1]; continue; }
  } else {
    if (run && run[1][0] === fence[0] && run[1].length >= fence.length && !run[2].trim()) {
      fence = null;
    }
    continue;
  }

  for (const m of line.matchAll(/`([^`]+)`/g)) {
    for (const p of citedPaths(m[1].trim())) {
      cited++;
      if (atRoot(p)) continue;
      if (suppressed(lines, i)) { suppressedCount++; continue; }
      if (!dead.has(p)) dead.set(p, []);
      dead.get(p).push(i + 1);
    }
  }
}

const suffix = suppressedCount ? ` (${suppressedCount} suppressed via filemap-ok)` : '';
console.log(`\nfilemap check — ${cited} cited path(s) in ${MAP}${suffix}`);

if (dead.size === 0) {
  console.log('✓ every cited path exists\n');
  process.exit(0);
}

console.log(`\n✗ ${dead.size} dead path(s):\n`);
for (const [p, at] of dead) console.log(`      ${MAP}:${at.join(',')}  ${p}`);
console.log('\n    FIX: a renamed file — update the index line AND the comments at both');
console.log('    binding sites. A deleted coupling — delete the index line. A bare');
console.log('    basename — cite the full repo-relative path. An extensionless');
console.log('    name — cite the file with its extension.\n');
process.exit(1);
