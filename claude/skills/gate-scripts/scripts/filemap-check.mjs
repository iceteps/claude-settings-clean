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
 * WHAT COUNTS AS A CITED PATH. Only inline code spans (`like/this.ts`) outside
 * fenced blocks, and only when the span is shaped like a repo path:
 *   - it contains a `/` AND its last segment has an extension, it ends in `/`,
 *     or its first segment exists at the repo root (so `src/hooks` counts and
 *     a package specifier like `@scope/pkg` does not); or
 *   - it has no `/`, does not start with `.`, and ends in a known source
 *     extension (`package.json`) — such a name is checked AT THE ROOT, so a
 *     bare basename like `theme.ts` fails: cite the full repo-relative path.
 * Skipped: whitespace, globs (`*` `?` `{}`), URLs and other `:` forms, `~` `$`
 * `<` and leading-`/` forms. A trailing `:12`, `:12-40` or `#L12` line
 * reference is stripped before the lookup, so `src/a.ts:42` is checked as
 * `src/a.ts`. Brackets and parentheses are kept: `app/[id].tsx` and
 * `app/(tabs)/index.tsx` are real route paths.
 *
 * Suppress a sanctioned citation (an example path, a file that is generated at
 * build time) with `<!-- filemap-ok: reason -->` on the line or the line above.
 * A tag with no reason does not suppress.
 *
 * Exits 0 (silently) when the map does not exist, so it is safe in the verify
 * chain of a project that keeps no FILEMAP. Paths resolve against the CWD — run
 * it from the repo root.
 *
 * Usage: node scripts/filemap-check.mjs [map=.claude/FILEMAP.md]
 */
import { readFileSync, existsSync } from 'node:fs';

const MAP = process.argv[2] ?? '.claude/FILEMAP.md';

/** Extensions that make a slash-less span a file citation rather than prose. */
const ROOT_EXTS = new Set([
  'c', 'cc', 'cjs', 'conf', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'ini',
  'java', 'js', 'json', 'jsx', 'kt', 'lock', 'lua', 'md', 'mjs', 'php', 'py',
  'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx',
  'txt', 'vue', 'yaml', 'yml',
]);

if (!existsSync(MAP)) {
  console.log(`\nfilemap check — no ${MAP}, nothing cited\n`);
  process.exit(0);
}

/** A span reduced to the repo-relative path it cites, or null if it cites none. */
function citedPath(span) {
  const p = span
    .replace(/#L\d+(-L?\d+)?$/, '')
    .replace(/:\d+(?:[-:]\d+)?$/, '')
    .replace(/^\.\//, '');
  if (!p || /\s/.test(p) || /[*?{}:]/.test(p) || /^[~$</]/.test(p)) return null;

  if (!p.includes('/')) {
    if (p.startsWith('.')) return null;
    const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
    return ROOT_EXTS.has(ext) ? p : null;
  }
  const segments = p.split('/');
  const last = segments[segments.length - 1];
  if (last === '' || /\.[A-Za-z0-9]{1,10}$/.test(last)) return p;
  return existsSync(segments[0]) ? p : null;
}

function suppressed(lines, i) {
  const tag = /filemap-ok:\s*\S/;
  return tag.test(lines[i]) || (i > 0 && tag.test(lines[i - 1]));
}

const lines = readFileSync(MAP, 'utf8').split('\n');
const dead = new Map(); // path -> map line numbers citing it
let cited = 0;
let suppressedCount = 0;
let fence = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const opener = line.match(/^\s*(`{3,}|~{3,})/);
  if (opener) {
    if (fence === null) fence = opener[1][0];
    else if (opener[1][0] === fence) fence = null;
    continue;
  }
  if (fence !== null) continue;

  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const p = citedPath(m[1].trim());
    if (p === null) continue;
    cited++;
    if (existsSync(p)) continue;
    if (suppressed(lines, i)) { suppressedCount++; continue; }
    if (!dead.has(p)) dead.set(p, []);
    dead.get(p).push(i + 1);
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
console.log('    basename — cite the full repo-relative path.\n');
process.exit(1);
