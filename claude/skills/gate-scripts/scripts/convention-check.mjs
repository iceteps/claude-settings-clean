#!/usr/bin/env node
/**
 * convention-check — enforce the rules your compiler cannot.
 *
 * Every codebase accumulates conventions that are load-bearing and invisible:
 * "only the drain may pass a 7th argument to clockIn", "never call String() on a
 * caught error", "this module may only be imported here". They hold because
 * somebody remembers. Then somebody new does the reasonable-looking thing and a
 * silent defect ships.
 *
 * This turns such a convention into a check, WITHOUT writing a new script each
 * time. Declare it in `.claude/conventions.json`; the rule text lives beside the
 * rule, so the failure message explains itself to whoever trips it.
 *
 * ── .claude/conventions.json ──────────────────────────────────────────────────
 * {
 *   "dirs": ["src"],
 *   "rules": [
 *     {
 *       "id": "offline-press-time",
 *       "kind": "call-arity",
 *       "call": "data.clockIn",
 *       "maxArgs": 6,
 *       "allow": ["src/lib/outbox-drain.ts"],
 *       "why": "Both providers derive `queued_offline` from the 7th argument, so
 *               any other caller silently stamps a row 'recorded late'.",
 *       "fix": "Clock in with six arguments and let the provider stamp now()."
 *     },
 *     {
 *       "id": "no-raw-error-string",
 *       "kind": "pattern",
 *       "pattern": "String\\\\(\\\\s*(err|error|e)\\\\s*\\\\)",
 *       "why": "Many HTTP clients reject with a PLAIN OBJECT, not an Error.
 *               String(obj) is '[object Object]' — it matches nothing and
 *               silently disables whatever branch depends on it.",
 *       "fix": "Read `.message` structurally, or prefer a structural signal."
 *     }
 *   ]
 * }
 *
 * `kind: "call-arity"`  — flags a call to `call` passing MORE than `maxArgs`
 *                         arguments, outside `allow`. Trailing commas, comments,
 *                         strings and nested calls are handled.
 *                         Matches `a.b(` and `a\n  .b(` alike.
 * `kind: "pattern"`     — flags a regex match outside `allow`.
 *
 * Suppress a sanctioned case with `// convention-ok(<id>): reason` on the line
 * or the line above. Reasons are reviewed like code.
 *
 * Exits 0 (silently) when no config exists, so it is safe in the verify chain of
 * a project that has not declared any conventions yet.
 *
 * Usage: node scripts/convention-check.mjs [config=.claude/conventions.json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const CONFIG = process.argv[2] ?? '.claude/conventions.json';
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

if (!existsSync(CONFIG)) {
  console.log(`\nconvention check — no ${CONFIG}, nothing declared\n`);
  process.exit(0);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (err) {
  console.error(`\nconvention check — ${CONFIG} is not valid JSON\n${err.message}\n`);
  process.exit(1);
}

const dirs = cfg.dirs?.length ? cfg.dirs : ['src'];
const rules = cfg.rules ?? [];

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (EXTS.includes(extname(p))) acc.push(p);
  }
  return acc;
}

/**
 * Argument count of a call, from the index of its opening paren.
 *
 * Skips comments and strings BEFORE touching the trailing-comma state — doing it
 * the other way round makes a trailing comment reset the flag and reports a
 * six-argument call as seven. A FAIL gate with a false positive is worse than no
 * gate, because the next person learns to bypass it.
 */
function countArgs(src, openIdx) {
  let depth = 0, args = 1;
  let inStr = null, inLine = false, inBlock = false, lastWasComma = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (/\s/.test(c)) continue;
    if (c === '"' || c === "'" || c === '`') { inStr = c; lastWasComma = false; continue; }
    if ('([{'.includes(c)) { depth++; lastWasComma = false; continue; }
    if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) return lastWasComma ? args - 1 : args;   // trailing comma
      lastWasComma = false;
      continue;
    }
    if (c === ',' && depth === 1) { args++; lastWasComma = true; continue; }
    lastWasComma = false;
  }
  return args;
}

/**
 * Blank out comments and string literals, preserving offsets and line breaks.
 *
 * A convention is about CODE. Without this, a rule fires on the comment that
 * EXPLAINS the rule — which is how the first run of this gate flagged the very
 * sentence warning people off the pattern. A FAIL gate that punishes you for
 * documenting it is one nobody keeps.
 */
function stripNonCode(src) {
  let out = '';
  let inStr = null, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; continue; }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; out += '  '; i++; }
      else out += c === '\n' ? c : ' ';
      continue;
    }
    if (inStr) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === inStr) { inStr = null; out += ' '; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; out += '  '; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

/**
 * Comments blanked, STRING LITERALS KEPT — for rules about a string's VALUE.
 *
 * `stripNonCode` blanks string contents too, which is right for rules about
 * code shape (`String(err)`) and fatal for rules about what a string SAYS:
 * `.select('*')` and `.select('id, name')` are byte-identical after it, so a
 * pattern targeting the first can never fire. That is not a tuning problem, it
 * is the strip erasing the evidence, and it silently passed a rule that had
 * been proven against nothing.
 *
 * Comments stay blanked in BOTH modes, so a rule never fires on the sentence
 * explaining it — which is the false positive that would otherwise make every
 * raw rule unusable as a FAIL class.
 */
function stripComments(src) {
  let out = '';
  let inStr = null, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; continue; }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; out += '  '; i++; }
      else out += c === '\n' ? c : ' ';
      continue;
    }
    if (inStr) {
      // Escapes are copied through: the value is what this mode exists to see.
      if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (c === inStr) inStr = null;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; out += '  '; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    out += c;
  }
  return out;
}

function suppressed(src, line, id) {
  const lines = src.split('\n');
  const here = lines[line - 1] ?? '';
  const above = lines[line - 2] ?? '';
  const tag = `convention-ok(${id})`;
  return here.includes(tag) || above.includes(tag);
}

const files = dirs.flatMap((d) => walk(d));
const findings = [];
let suppressedCount = 0;

for (const rule of rules) {
  const allow = rule.allow ?? [];
  /* Per-rule scope. A rule whose REASON is about one surface must only be
     checked there: a browser-bundle rule fired at server-side code is not a
     finding, it is noise, and noise is what turns a FAIL class into a gate
     people learn to skip. Absent `dirs` means every scanned directory. */
  const scope = rule.dirs ?? null;
  for (const file of files) {
    if (scope && !scope.some((d) => file.startsWith(d))) continue;
    if (allow.some((a) => file.includes(a))) continue;
    const src = readFileSync(file, 'utf8');

    if (rule.kind === 'call-arity') {
      // A regex, not indexOf: prettier breaks a long member chain across lines,
      // and a literal search walks straight past `data\n  .clockIn(`.
      const [obj, method] = rule.call.split('.');
      const re = new RegExp(`\\b${obj}\\s*\\.\\s*${method}\\s*\\(`, 'g');
      for (let m; (m = re.exec(src)); ) {
        const args = countArgs(src, m.index + m[0].length - 1);
        if (args <= rule.maxArgs) continue;
        const line = src.slice(0, m.index).split('\n').length;
        if (suppressed(src, line, rule.id)) { suppressedCount++; continue; }
        findings.push({ rule, file, line, detail: `${args} args (max ${rule.maxArgs})` });
      }
    } else if (rule.kind === 'pattern') {
      /* `raw: true` keeps string literals so a rule can test what a string
         SAYS, not just where it sits. Comments are blanked either way. */
      const code = rule.raw ? stripComments(src) : stripNonCode(src);
      const re = new RegExp(rule.pattern, 'g');
      for (let m; (m = re.exec(code)); ) {
        const line = code.slice(0, m.index).split('\n').length;
        if (suppressed(src, line, rule.id)) { suppressedCount++; continue; }
        findings.push({ rule, file, line, detail: m[0].slice(0, 60) });
      }
    } else {
      console.error(`convention check — rule "${rule.id}" has unknown kind "${rule.kind}"`);
      process.exit(1);
    }
  }
}

const suffix = suppressedCount ? ` (${suppressedCount} suppressed via convention-ok)` : '';
console.log(`\nconvention check — ${rules.length} rule(s) over ${files.length} files${suffix}`);

if (findings.length === 0) {
  console.log('✓ every declared convention holds\n');
  process.exit(0);
}

console.log(`\n✗ ${findings.length} violation(s):\n`);
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, []);
  byRule.get(f.rule.id).push(f);
}
for (const [id, hits] of byRule) {
  const rule = hits[0].rule;
  console.log(`  ${id}`);
  if (rule.why) console.log(`    ${rule.why.replace(/\s+/g, ' ')}`);
  for (const h of hits) console.log(`      ${h.file}:${h.line}  ${h.detail}`);
  if (rule.fix) console.log(`    FIX: ${rule.fix.replace(/\s+/g, ' ')}`);
  console.log('');
}
process.exit(1);
