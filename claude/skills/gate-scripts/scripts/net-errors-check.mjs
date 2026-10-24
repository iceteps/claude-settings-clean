#!/usr/bin/env node
/**
 * net-errors-check — the gate for code that decides what KIND of failure an
 * error is ("wait for signal" vs "throw this away" vs "the server already has
 * it"). Doctrine: the `offline-first-writes` skill, failure modes A and C, and
 * gate-scripts/net-errors.md.
 *
 * The defect it exists for: a retry classifier read `String(err)`. The HTTP
 * client rejected with a PLAIN OBJECT `{ message, details, hint, code }`, so
 * the string was "[object Object]", matched no pattern, and nothing was ever
 * queued. It compiled, every type was `unknown`, and the mock-backed test suite
 * never produced a network error. The whole offline feature was dead while
 * looking correct.
 *
 * Two halves, both dependency-free:
 *
 * 1. STATIC SCAN of the source dirs (always runs).
 *    FAIL classes (exit 1):
 *      stringified-classify  a PROVEN caught error stringified (String(x),
 *                            x.toString(), x + '', `${x}`, JSON.stringify(x))
 *                            or implicitly coerced (re.test(x)) and fed straight
 *                            to a matcher. For a plain-object rejection that
 *                            string is "[object Object]": the branch never fires.
 *      bare-suppression      a neterr-ok comment with no written reason.
 *    WARN classes (advisory, exit 0):
 *      stringified-error     the same stringification where the value is not
 *                            proven a caught error (a name like `error` that may
 *                            be a state string, a shadowed or unresolved scope),
 *                            or a proven one not fed to a matcher on the spot.
 *      instanceof-only       `x instanceof Error ? x.message : ...` — a plain
 *                            object takes the else branch and its message is lost.
 *      timeout-unchecked     a predicate module is declared but no timeout shape
 *                            is, so failure mode C (a timeout is NOT a definite
 *                            failure) is not asserted.
 *    PROVEN caught error = the binding of `catch (x) {}` or a `.catch(` handler,
 *    or an error-named parameter annotated `: unknown` / `: any`, each scoped to its body and
 *    only up to the first rebinding of the name. That scoping is what keeps the
 *    FAIL class at zero false positives; `--selftest` proves it.
 *
 * 2. PREDICATE FIXTURES (runs when the config declares `module`).
 *    Loads the project's error-classification module and asserts its answers
 *    against REAL error shapes: built-in presets plus the project's own `cases`.
 *    Predicates are judged by truthiness. The module must be dependency-free so
 *    it can be loaded alone; a `.ts` module is compiled with the project's own
 *    node_modules/.bin/tsc (never a download) or, failing that, imported through
 *    Node's type stripping (Node >= 22.6). Loading it RUNS the repo's code.
 *
 * ── config: the first argument, else .claude/net-errors.json, else
 *    $GATE_STATE_DIR/net-errors.json (keys documented in net-errors.md) ───────
 * {
 *   "dirs": ["src"], "allow": [], "errorNames": ["err", "error", "exception"],
 *   "module": "src/lib/net-errors.ts",
 *   "exports": { "text": "errText", "retryable": "isRetryable",
 *                "alreadyRecorded": "isAlreadyRecorded" },
 *   "presets": ["fetch"], "timeoutError": "NETWORK_TIMEOUT: probe (20s)",
 *   "cases": [ { "label": "duplicate close", "value": { "$error": "Already closed" },
 *                "retryable": false, "alreadyRecorded": true } ]
 * }
 *
 * SUPPRESSION — the reason is mandatory, on the line or the line above:
 *   // neterr-ok(stringified-error): err is always a string from the parser
 * Unused suppressions are reported so they cannot rot in place.
 *
 * Usage: node net-errors-check.mjs [config] [--json]
 *        node net-errors-check.mjs --selftest
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_DIRS = ['src', 'app', 'lib', 'source'];
const DEFAULT_ERROR_NAMES = ['err', 'error', 'exception'];
const DEFAULT_EXPORTS = { text: 'errText', retryable: 'isRetryable', alreadyRecorded: 'isAlreadyRecorded' };

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');

if (ARGS.includes('--selftest')) process.exit(selftest());

/* ── config ──────────────────────────────────────────────────────────────── */

/* An explicit argument wins, then repo-committed config (a repo that carries
   its bar), then the external runner's state dir, so a repo you do not own can
   still be configured without a file in its tree. No config at all still runs
   the static scan. */
function findConfig() {
  const explicit = ARGS.find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  if (existsSync('.claude/net-errors.json')) return '.claude/net-errors.json';
  const state = process.env.GATE_STATE_DIR;
  if (state && existsSync(join(state, 'net-errors.json'))) return join(state, 'net-errors.json');
  return null;
}

const CONFIG = findConfig();
let cfg = {};
if (CONFIG) {
  if (!existsSync(CONFIG)) {
    console.error(`\nnet-errors check — config ${CONFIG} does not exist\n`);
    process.exit(1);
  }
  try {
    cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    console.error(`\nnet-errors check — ${CONFIG} is not valid JSON\n${err.message}\n`);
    process.exit(1);
  }
}

const posix = (p) => p.split(sep).join('/');
const dirs = cfg.dirs?.length ? cfg.dirs : DEFAULT_DIRS.filter((d) => existsSync(d));
const modulePath = cfg.module ? posix(relative('.', resolve(cfg.module))) : null;
const allow = [...(cfg.allow ?? []), ...(modulePath ? [modulePath] : [])];
const errorNames = cfg.errorNames ?? DEFAULT_ERROR_NAMES;

/* ── findings plumbing ───────────────────────────────────────────────────── */

const errors = [];
const warnings = [];
const unusedSuppressions = [];
let suppressedCount = 0;

const MESSAGES = {
  'stringified-classify':
    'A caught error stringified and matched. A plain-object rejection reads "[object Object]" and the branch never fires. Read .message structurally (an errText-style helper), or test a structural field.',
  'bare-suppression':
    'A neterr-ok suppression must carry a written reason after the colon. Without one it suppresses nothing.',
  'stringified-error':
    'Something that may be a caught error is stringified. If a plain-object rejection reaches this, it becomes "[object Object]".',
  'instanceof-only':
    'The message is read only for Error instances. Clients that reject with plain objects take the else branch and lose the message.',
  'timeout-unchecked':
    'A predicate module is declared without "timeoutError": failure mode C (a timeout is not a definite failure) is unasserted.',
  'fixture':
    'The classification module answers wrongly for a real error shape. Fix the predicate, not the case.',
  'module':
    'The classification module could not be loaded or does not export what the config names.',
};

function record(level, cls, file, line, text) {
  // Scan hits are source excerpts and get clipped; fixture verdicts never are.
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const hit = { cls, file, line, text: line ? flat.slice(0, 100) : flat };
  (level === 'error' ? errors : warnings).push(hit);
}

/* ── lexer: two views of a file, offsets and line breaks preserved ───────── */

const REGEX_AFTER_CHAR = '(,=:[!&|?{};';
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|yield|await)\s*$/;
const LETTER = /\p{L}/u;

/**
 * `blank`   — comments and the contents of every string, template and regex
 *             literal blanked. Brackets are matched on this view.
 * `pattern` — comments blanked; ' and " contents blanked (delimiters kept, so
 *             `'' + e` stays visible); template contents KEPT, because `${e}`
 *             is evidence; regex contents blanked. Patterns run on this view, so
 *             a test title like it('flags String(err).includes') cannot FAIL.
 *
 * Desync guards, each a real false positive once: a ' between two letters is
 * JSX prose (Can't), not a string; ' and " strings end at a newline; a / that
 * starts an operand (including right after `=>`) is a regex literal and quotes
 * inside it are not strings. A ' or " string that hits a newline unclosed means
 * the lexer guessed wrong somewhere on that line, and so does a regex literal
 * that does: either offset goes in `desync`,
 * and any scope containing one is treated as unresolved (WARN, never FAIL).
 */
function lex(src) {
  let blank = '', pattern = '';
  let mode = null, inClass = false, operand = false;
  const desync = [];
  const put = (b, p = b) => { blank += b; pattern += p; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (mode === 'line') { if (c === '\n') { mode = null; put(c); } else put(' '); continue; }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = null; put('  '); i++; }
      else put(c === '\n' ? c : ' ');
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (c === '\\' && next !== undefined) { put(' ' + (next === '\n' ? '\n' : ' ')); i++; continue; }
      if (c === '\n') { mode = null; operand = true; desync.push(i); put(c); continue; }
      if (c === mode) { mode = null; operand = true; put(' ', c); continue; }
      put(' ');
      continue;
    }
    if (mode === '`') {
      if (c === '\\' && next !== undefined) { put(' ' + (next === '\n' ? '\n' : ' '), c + next); i++; continue; }
      if (c === '`') { mode = null; operand = true; put(' ', c); continue; }
      put(c === '\n' ? c : ' ', c);
      continue;
    }
    if (mode === '/') {
      if (c === '\n') { mode = null; desync.push(i); put(c); continue; } // was division after all
      if (c === '\\' && next !== undefined && next !== '\n') { put('  '); i++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { mode = null; operand = true; put(c); continue; }
      put(' ');
      continue;
    }
    if (c === '/' && next === '/') { mode = 'line'; put('  '); i++; continue; }
    if (c === '/' && next === '*') { mode = 'block'; put('  '); i++; continue; }
    if (c === '/' && (!operand || REGEX_AFTER_WORD.test(blank.slice(-12)))) {
      mode = '/'; inClass = false; put(c);
      continue;
    }
    if (c === "'" && LETTER.test(src[i - 1] ?? '') && LETTER.test(next ?? '')) { put(c); continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; put(' ', c); continue; }
    put(c);
    if (!/\s/.test(c)) operand = !REGEX_AFTER_CHAR.includes(c) && !(c === '>' && src[i - 1] === '=');
  }
  return { blank, pattern, desync };
}

/** Index of the bracket closing the one at `open`; code.length if unresolved. */
function matchClose(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return code.length;
}

/** End of an arrow's expression body: a depth-0 ; or , or closer, or a newline
 *  not followed by a chained call. */
function exprEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === ';' || c === ',')) return i;
    else if (depth === 0 && c === '\n' && !/^\s*\??\./.test(code.slice(i + 1, i + 80))) return i;
  }
  return code.length;
}

/* ── scopes: where an identifier is PROVEN to hold a caught error ────────── */

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * Each scope: { name, from, to, resolved }. `from` is where the binding ends, so
 * the binding itself is never mistaken for a rebinding.
 *   catch (x) { ... }                       the block
 *   .catch((x) => ...) / .catch(x => ...)   the argument list of .catch(
 *   (x: unknown) => ... / function f(x: any) { ... }   the body
 * `view` is the pattern view: an arrow body's first token is found there, since
 * the blank view has already erased a leading template literal.
 */
function provenScopes(code, view) {
  const scopes = [];
  const blockRe = new RegExp(`\\bcatch\\s*\\(\\s*(${IDENT})\\s*(?::[^)]*)?\\)\\s*\\{`, 'g');
  for (let m; (m = blockRe.exec(code)); ) {
    const open = m.index + m[0].length - 1;
    scopes.push(scope(m[1], open, matchClose(code, open)));
  }
  const callRe = new RegExp(`\\.\\s*catch\\s*\\(\\s*(?:async\\s+)?(?:function\\s*(?:${IDENT})?\\s*)?\\(?\\s*(${IDENT})(?=\\s*[):=,])`, 'g');
  for (let m; (m = callRe.exec(code)); ) {
    const open = code.indexOf('(', m.index);
    const s = scope(m[1], open, matchClose(code, open));
    s.from = m.index + m[0].length;
    scopes.push(s);
  }
  const typedRe = new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\??\\s*:\\s*(unknown|any)\\b(?=\\s*[,)=])`, 'g');
  for (let m; (m = typedRe.exec(code)); ) {
    const kind = errorish(m[1], m[2]);
    if (!kind) continue; // `val: unknown` is a value, not a rejection
    const open = enclosingParen(code, m.index);
    if (open < 0) continue;
    const close = matchClose(code, open);
    const after = /^\s*(?::\s*[^=;{}()]*?)?\s*(=>|\{)/.exec(code.slice(close + 1, close + 300));
    if (!after) continue;
    let body = close + 1 + after[0].length - (after[1] === '{' ? 1 : 0);
    if (after[1] === '=>') while (/\s/.test(view[body] ?? '')) body++;
    const end = code[body] === '{' ? matchClose(code, body) : exprEnd(code, body);
    const s = scope(m[1], body, end);
    if (kind === 'weak') s.resolved = false; // never proven: WARN at most
    scopes.push(s);
  }
  return scopes;

  function scope(name, from, to) {
    return { name, from, to, resolved: to < code.length };
  }
}

const ERROR_WORDS = new Set(['err', 'error', 'errors', 'exc', 'exception', 'rejection']);
const AMBIGUOUS_WORDS = new Set(['e', 'ex', 'reason', 'cause']); // proven only with `: unknown`

/**
 * Does a typed parameter's NAME say it is an error? 'proven', 'weak' or null.
 * Whole name SEGMENTS, never substrings: `fetchErr` and `load_error` count,
 * `referrer`, `terrain` and `interrupt` do not. An ambiguous word is proven
 * only under `: unknown`, the type of a catch binding; `(e: any)` may be a
 * number and `(cause: any)` a diagnosis, so those are 'weak' (WARN at most).
 */
function errorish(name, type) {
  if (errorNames.includes(name)) return 'proven';
  const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_$]+/);
  if (parts.some((p) => ERROR_WORDS.has(p))) return 'proven';
  if (parts.some((p) => AMBIGUOUS_WORDS.has(p))) return type === 'unknown' ? 'proven' : 'weak';
  return null;
}

/** The unmatched '(' this offset sits in, or -1 when it sits in {} / [] first. */
function enclosingParen(code, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0 && at - i < 2000; i--) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(') { if (depth === 0) return i; depth--; }
    else if (c === '[' || c === '{') { if (depth === 0) return -1; depth--; }
    else if (c === ';' && depth === 0) return -1;
  }
  return -1;
}

/** First offset in [from, to) where `name` is bound again; `to` when never. */
function rebindAt(code, name, from, to) {
  const id = escapeRe(name);
  const inList = new RegExp(`(?:^|[\\s,({\\[])${id}\\s*(?:[,:=?)}\\]]|$)`);
  const direct = [
    new RegExp(`(?<![\\w$.])${id}\\s*=>`, 'g'),
    new RegExp(`\\bcatch\\s*\\(\\s*${id}(?![\\w$])`, 'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${id}(?![\\w$])`, 'g'),
  ];
  const lists = [
    /\(([^()]*)\)\s*(?::[^=;{}()]*)?=>/g,
    new RegExp(`\\bfunction\\b\\s*(?:${IDENT})?\\s*\\(([^()]*)\\)`, 'g'),
  ];
  let first = to;
  const region = code.slice(from, to);
  for (const re of direct) {
    const m = re.exec(region);
    if (m) first = Math.min(first, from + m.index);
  }
  for (const re of lists) {
    for (let m; (m = re.exec(region)); ) {
      if (inList.test(m[1])) { first = Math.min(first, from + m.index); break; }
    }
  }
  return first;
}

/* ── suppressions ────────────────────────────────────────────────────────── */

const SUPPRESS_RE = /neterr-ok\(\s*([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*\)\s*(?::\s*(\S.*))?/;

/** Map<targetLine, { classes, declLine, used }>; reasonless ones FAIL. */
function parseSuppressions(lines, file) {
  const map = new Map();
  lines.forEach((line, idx) => {
    const m = SUPPRESS_RE.exec(line);
    if (!m) return;
    const declLine = idx + 1;
    const reason = (m[2] ?? '').replace(/\*\/\s*\}?\s*$/, '').trim();
    if (!reason) { record('error', 'bare-suppression', file, declLine, line); return; }
    // Comment-only line guards the NEXT line; a trailing comment guards its own.
    const target = /^\s*(\/\/|\/\*|\{\s*\/\*)/.test(line) ? declLine + 1 : declLine;
    map.set(target, { classes: new Set(m[1].split(',').map((s) => s.trim())), declLine, used: false });
  });
  return map;
}

/* ── static scan ─────────────────────────────────────────────────────────── */

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Identifier alternation N as a whole token, never a property (`x.err`). */
const tok = (N) => `(?<![\\w$.])(?:${N})(?![\\w$])`;
const EMPTY_STR = "(?:''|\"\"|``)";

/** Every way a value becomes a string. */
function stringified(N) {
  const n = tok(N);
  return '(?:' + [
    `\\bString\\(\\s*${n}(?:\\s+as\\s+[\\w$.<>\\[\\]| ]+?)?\\s*\\)`,
    `${n}\\s*\\??\\.\\s*toString\\(\\s*\\)`,
    `\\bJSON\\.stringify\\(\\s*${n}\\s*\\)`,
    `\`(?:[^\`\\\\]|\\\\.)*?\\$\\{\\s*${n}\\s*\\}(?:[^\`\\\\]|\\\\.)*?\``,
    `${n}\\s*\\+\\s*${EMPTY_STR}`,
    `${EMPTY_STR}\\s*\\+\\s*${n}`,
  ].join('|') + ')';
}
const MATCHERS = 'includes|match|matchAll|startsWith|endsWith|search|indexOf|test';
const CASE_FOLD = '(?:\\s*\\??\\.\\s*(?:toLowerCase|toUpperCase|toLocaleLowerCase|trim)\\(\\s*\\))*';

function classifyRe(N) {
  const s = `(?:${stringified(N)}|\\(\\s*${stringified(N)}\\s*\\))`;
  return new RegExp(
    `\\.\\s*(?:test|exec|search)\\(\\s*${s}` +           // re.test(String(e))
    `|\\.\\s*(?:test|exec)\\(\\s*${tok(N)}\\s*\\)` +       // re.test(e): implicit coercion
    `|${s}${CASE_FOLD}\\s*\\??\\.\\s*(?:${MATCHERS})\\(`,  // String(e).includes(
    'g',
  );
}
const stringifyRe = (N) => new RegExp(stringified(N), 'g');
const INSTANCEOF_RE = /\b([A-Za-z_$][\w$]*)\s+instanceof\s+Error\s*\?[^;\n]{0,80}?\b\1\s*\.\s*message\b/g;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (EXTS.has(extname(p)) && !p.endsWith('.d.ts')) acc.push(posix(p));
  }
  return acc;
}

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  const { blank, pattern, desync } = lex(src);
  const sup = parseSuppressions(src.split('\n'), file);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  const hits = new Map(); // offset -> { level, cls, text }
  const hit = (idx, level, cls, text) => {
    const prev = hits.get(idx);
    if (!prev || (prev.level === 'warn' && level === 'error')) hits.set(idx, { level, cls, text });
  };
  const collect = (re, from, to, onHit) => {
    re.lastIndex = from;
    for (let m; (m = re.exec(pattern)) && m.index < to; ) onHit(m);
  };

  // Names that merely LOOK like errors: never proven, so WARN at most.
  const named = errorNames.map(escapeRe).join('|');
  if (named) {
    collect(stringifyRe(named), 0, pattern.length, (m) => hit(m.index, 'warn', 'stringified-error', m[0]));
    collect(classifyRe(named), 0, pattern.length, (m) => hit(m.index, 'warn', 'stringified-error', m[0]));
  }
  for (const s of provenScopes(blank, pattern)) {
    if (desync.some((d) => d >= s.from && d < s.to)) s.resolved = false;
    const N = escapeRe(s.name);
    const proven = s.resolved ? rebindAt(blank, s.name, s.from, s.to) : s.from;
    collect(classifyRe(N), s.from, s.to, (m) =>
      hit(m.index, m.index < proven ? 'error' : 'warn', m.index < proven ? 'stringified-classify' : 'stringified-error', m[0]));
    collect(stringifyRe(N), s.from, s.to, (m) => hit(m.index, 'warn', 'stringified-error', m[0]));
  }
  collect(INSTANCEOF_RE, 0, pattern.length, (m) => hit(m.index, 'warn', 'instanceof-only', m[0]));

  // One finding per line: a FAIL there absorbs the WARNs it contains.
  const byLine = new Map();
  for (const [idx, h] of hits) {
    const line = lineOf(idx);
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(h);
  }
  for (const [line, list] of byLine) {
    const fails = list.filter((h) => h.level === 'error');
    for (const h of fails.length ? fails : list) {
      const s = sup.get(line);
      if (s && s.classes.has(h.cls)) { s.used = true; suppressedCount++; continue; }
      record(h.level, h.cls, file, line, h.text);
    }
  }
  for (const s of sup.values()) if (!s.used) unusedSuppressions.push(`${file}:${s.declLine}`);
}

const files = dirs.flatMap((d) => walk(d)).filter((f) => !allow.some((a) => f.includes(a)));
for (const f of files) scanFile(f);

/* ── predicate fixtures ──────────────────────────────────────────────────── */

const ERROR_CTORS = { Error, TypeError, RangeError, SyntaxError };

/** JSON value spec → the runtime value the predicate will be handed. */
function materialize(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !('$error' in spec)) return spec;
  const { $error, $name = 'Error', ...props } = spec;
  const err = new (ERROR_CTORS[$name] ?? Error)($error);
  if (!ERROR_CTORS[$name]) err.name = $name;
  return Object.assign(err, props);
}

/* Shapes every project with that client really produces. Network failures are
   retryable; definite refusals and non-errors are not; none of them is ever
   "already recorded". Project-specific sentences belong in `cases`. */
const NOT_RECORDED = { alreadyRecorded: false };
const PRESETS = {
  fetch: [
    { label: 'fetch failure, browser', value: { $error: 'Failed to fetch', $name: 'TypeError' }, retryable: true },
    { label: 'fetch failure, React Native', value: { $error: 'Network request failed', $name: 'TypeError' }, retryable: true },
    { label: 'fetch failure, Node', value: { $error: 'fetch failed', $name: 'TypeError' }, retryable: true },
    { label: 'fetch failure rethrown as a PLAIN OBJECT (failure mode A)',
      value: { message: 'TypeError: Network request failed' }, retryable: true },
    { label: 'null', value: null, retryable: false },
    { label: 'a bare string', value: 'something went wrong', retryable: false },
    { label: 'an empty object', value: {}, retryable: false },
  ],
  postgrest: [
    { label: 'PostgREST offline, plain object (failure mode A)',
      value: { message: 'TypeError: Network request failed', details: '', hint: '', code: '' }, retryable: true },
    { label: 'PostgREST offline via status 0',
      value: { message: '', details: null, hint: null, code: '', status: 0 }, retryable: true },
    { label: 'row-level security denial',
      value: { message: 'new row violates row-level security policy', code: '42501' }, retryable: false },
    { label: 'not-null violation',
      value: { message: 'null value in column "id" violates not-null constraint', code: '23502' }, retryable: false },
  ],
};

async function loadModule(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`${path} does not exist`);
  if (!/\.tsx?$/.test(abs)) return import(pathToFileURL(abs).href);
  const tsc = resolve('node_modules/.bin/tsc');
  if (!existsSync(tsc)) return import(pathToFileURL(abs).href); // Node type stripping
  const out = mkdtempSync(join(tmpdir(), 'net-errors-check-'));
  try {
    writeFileSync(join(out, 'package.json'), '{"type":"module"}\n');
    execFileSync(tsc, [abs, '--outDir', out, '--target', 'es2020', '--module', 'es2020',
      '--moduleResolution', 'bundler', '--strict', '--skipLibCheck'], { stdio: 'pipe' });
    const built = join(out, basename(abs).replace(/\.tsx?$/, '.js'));
    if (!existsSync(built)) throw new Error('compiled output missing — the module must be dependency-free');
    return await import(pathToFileURL(built).href);
  } catch (err) {
    throw new Error(String(err.stdout ?? '').trim().slice(0, 800) || err.message);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const THREW = Symbol('threw');
/** A predicate that THROWS on a shape is as wrong as one that answers wrongly. */
function safe(f) {
  try { return f(); } catch { return THREW; }
}
const shown = (v) => (v === THREW ? 'threw' : JSON.stringify(v));

async function runFixtures() {
  if (!cfg.module) return 0;
  if (cfg.timeoutError == null) record('warn', 'timeout-unchecked', CONFIG, 0, 'add "timeoutError" to the config');
  const presets = cfg.presets ?? ['fetch'];
  for (const p of presets) if (!PRESETS[p]) record('error', 'module', CONFIG, 0, `unknown preset "${p}"`);

  let mod;
  try {
    mod = await loadModule(cfg.module);
  } catch (err) {
    record('error', 'module', modulePath, 0, err.message);
    return 0;
  }
  const names = { ...DEFAULT_EXPORTS, ...(cfg.exports ?? {}) };
  const fn = (role) => (typeof mod[names[role]] === 'function' ? mod[names[role]] : null);
  const text = fn('text');
  const retryable = fn('retryable');
  const recorded = fn('alreadyRecorded');
  if (!retryable) {
    record('error', 'module', modulePath, 0, `no exported function "${names.retryable}" (exports.retryable)`);
    return 0;
  }

  const cases = [];
  for (const p of presets.filter((name) => PRESETS[name])) {
    cases.push(...PRESETS[p].map((c) => ({ ...NOT_RECORDED, ...c })));
  }
  if (cfg.timeoutError != null) {
    const value = typeof cfg.timeoutError === 'string' ? { $error: cfg.timeoutError } : cfg.timeoutError;
    cases.push({ label: 'timeout (failure mode C: not a definite failure)', value, retryable: true, alreadyRecorded: false });
  }
  const own = cfg.cases ?? [];
  cases.push(...own);

  // Predicates are judged by truthiness: callers branch on them with `if`.
  const verdict = (f, value) => { const r = safe(() => f(value)); return r === THREW ? r : Boolean(r); };
  for (const c of cases) {
    const value = materialize(c.value);
    const read = text ? `   (${names.text}: ${shown(safe(() => text(value)))})` : '';
    if (c.retryable != null) {
      const got = verdict(retryable, value);
      if (got !== c.retryable) record('error', 'fixture', modulePath, 0, `${c.label}: ${names.retryable} -> ${shown(got)}, expected ${c.retryable}${read}`);
    }
    if (c.alreadyRecorded != null) {
      if (!recorded) {
        if (own.includes(c)) record('error', 'module', modulePath, 0, `case "${c.label}" expects ${names.alreadyRecorded}, which is not exported`);
        continue;
      }
      const got = verdict(recorded, value);
      if (got !== c.alreadyRecorded) record('error', 'fixture', modulePath, 0, `${c.label}: ${names.alreadyRecorded} -> ${shown(got)}, expected ${c.alreadyRecorded}`);
    }
  }

  // The message reader itself: the exact step that failed the first time.
  if (text) {
    const probes = [
      ['plain object message not read', { message: 'x' }, 'x'],
      ['Error message not read', new Error('y'), 'y'],
      ['object without a message must read as \'\', never "[object Object]"', {}, ''],
    ];
    for (const [label, value, want] of probes) {
      const got = safe(() => text(value));
      if (got !== want) record('error', 'fixture', modulePath, 0, `${names.text}: ${label} (got ${shown(got)})`);
    }
  }
  return cases.length;
}

const caseCount = await runFixtures();

/* ── output ──────────────────────────────────────────────────────────────── */

const checked = files.length > 0 || Boolean(cfg.module);
const exitCode = errors.length ? 1 : 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ checked, files: files.length, cases: caseCount, errors, warnings,
    unused: unusedSuppressions, suppressed: suppressedCount }));
  process.exit(exitCode);
}

if (!checked) {
  console.log('\nnet-errors check — nothing to check (no source dirs, no module)\n');
  process.exit(0);
}

const byClass = (list) => {
  const g = new Map();
  for (const h of list) {
    if (!g.has(h.cls)) g.set(h.cls, []);
    g.get(h.cls).push(h);
  }
  return g;
};
const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
errors.sort(byPlace);
warnings.sort(byPlace);
const at = (h) => (h.line ? `${h.file}:${h.line}` : h.file);

console.log(`\nnet-errors check — scanned ${files.length} files in ${dirs.join(', ') || '(no source dirs)'}` +
  (cfg.module ? `; ${caseCount} error shape(s) against ${modulePath}` : '; no predicate module declared') +
  (suppressedCount ? ` (${suppressedCount} suppressed via neterr-ok)` : ''));

if (unusedSuppressions.length) {
  console.log(`\n⚠  ${unusedSuppressions.length} UNUSED neterr-ok suppression(s) — the finding is gone, remove the comment:`);
  for (const u of unusedSuppressions) console.log(`   - ${u}`);
}

if (warnings.length) {
  for (const [cls, hits] of byClass(warnings)) {
    console.log(`\n⚠  ${hits.length} ${cls}`);
    console.log(`   ${MESSAGES[cls]}`);
    for (const h of hits.slice(0, 12)) console.log(`   - ${at(h)}  ${h.text}`);
    if (hits.length > 12) console.log(`   … and ${hits.length - 12} more`);
  }
  console.log('\nWarnings need a human call — they do not fail the build.');
}

if (errors.length) {
  console.error('');
  for (const [cls, hits] of byClass(errors)) {
    console.error(`✖  ${hits.length} ${cls}`);
    console.error(`   ${MESSAGES[cls]}`);
    for (const h of hits) console.error(`   - ${at(h)}  ${h.text}`);
    console.error('');
  }
  console.error(`✖ ${errors.length} net-error violation(s). A wrong answer here is invisible in normal use:`);
  console.error('  a mock backend never throws a network error. For a sanctioned case add: // neterr-ok(<class>): <reason>');
  process.exit(1);
}

console.log('✓ every caught error is read structurally and every known shape classifies correctly\n');

/* ── --selftest: the calibration, proven mechanically ────────────────────── */

/**
 * Every case is a tiny repo written to a tmpdir and scanned by this script as a
 * child process. `fail` and `warn` are the EXACT sets of file:line findings, so
 * a new false positive breaks the self-test as surely as a missed violation.
 * The scan inputs are the false positives and false negatives an adversarial
 * review found; the module cases re-inject each defect the original gate caught.
 */
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failed = 0;
  const cases = selftestCases();
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), 'net-errors-selftest-'));
    try {
      for (const [path, body] of Object.entries(c.files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      const args = [self, '--json'];
      if (c.config) {
        writeFileSync(join(root, 'net-errors.json'), JSON.stringify(c.config));
        args.push('net-errors.json');
      }
      const env = { ...process.env };
      delete env.GATE_STATE_DIR;
      const run = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
      const problems = judge(c.expect, run);
      console.log(`${problems.length ? '✖' : '✓'} ${c.name}`);
      for (const p of problems) console.log(`    ${p}`);
      if (problems.length) failed++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`\nnet-errors selftest — ${cases.length - failed}/${cases.length} cases as expected`);
  return failed ? 1 : 0;
}

function judge(expect, run) {
  let out;
  try { out = JSON.parse(run.stdout); } catch { return [`no JSON output (exit ${run.status}): ${run.stderr.slice(0, 300)}`]; }
  const problems = [];
  const places = (list, classes) =>
    list.filter((h) => !classes || classes.includes(h.cls)).map((h) => `${h.file}:${h.line}`).sort();
  const same = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify([...want].sort());
    if (g !== w) problems.push(`${label}: got ${g}, expected ${w}`);
  };
  if (run.status !== expect.exit) problems.push(`exit ${run.status}, expected ${expect.exit}`);
  const SCAN = ['stringified-classify', 'bare-suppression', 'stringified-error', 'instanceof-only'];
  if (expect.fail) same('FAIL', places(out.errors, SCAN), expect.fail);
  if (expect.warn) same('WARN', places(out.warnings, SCAN), expect.warn);
  for (const cls of ['fixture', 'module']) {
    if (expect[cls] == null) continue;
    const n = out.errors.filter((h) => h.cls === cls).length;
    if (n !== expect[cls]) problems.push(`${cls} failures: got ${n}, expected ${expect[cls]}`);
  }
  if (expect.unused != null && out.unused.length !== expect.unused) problems.push(`unused suppressions: got ${out.unused.length}, expected ${expect.unused}`);
  if (expect.suppressed != null && out.suppressed !== expect.suppressed) problems.push(`suppressed: got ${out.suppressed}, expected ${expect.suppressed}`);
  if (expect.checked != null && out.checked !== expect.checked) problems.push(`checked: got ${out.checked}, expected ${expect.checked}`);
  return problems;
}

/* Generated from the review reproductions and the re-injection fixtures. */
function selftestCases() {
  return [
    {
      name: "review false positives: DOM events, state strings, nested, shadowed, JSX apostrophe, test titles",
      files: {
        "src/a.tsx": "// 1 DOM event outside catch\nfunction onKey(e) { if (String(e.key).includes('Enter')) go(); }\nfunction onKey2(e) { const s = String(e); if (s.includes('x')) go(); }\n// 2 template strings of non-errors\nconst label = `${count}`.includes('1');\n// 3 .includes on message (correct)\ntry { a(); } catch (e) { if (errText(e).includes('Failed')) q(); if (e.message.includes('x')) q(); }\n// 4 variable named error that is not a caught error\nconst [error, setError] = useState('');\nif (String(error).includes('required')) show();\nfunction validate(v) { const error = v ? '' : 'required'; return `${error}`.startsWith('req'); }\n// 5 nested catch\ntry { a(); } catch (outer) {\n  try { b(); } catch (inner) { log(errText(inner)); }\n  if (errText(outer).includes('x')) q();\n}\n// 6 arrow and function handlers\np.catch((e) => errText(e).includes('x'));\np.catch(function (e) { return errText(e).includes('x'); });\np.catch(async e => { await f(); return errText(e).match(/x/); });\n// 7 TS annotations\ntry { a(); } catch (e: unknown) { if (errText(e).includes('x')) q(); }\np.catch((e: unknown): boolean => errText(e).includes('x'));\n// 8 optional catch binding\ntry { a(); } catch { q(); }\nconst key = (e) => String(e).includes('x');\n// 9 shadowed binding inside catch\ntry { a(); } catch (e) { items.forEach((e) => { if (String(e).startsWith('id-')) q(); }); }\n// 10 JSX apostrophe then later event\nfunction Help() { try { a(); } catch (x) { log(errText(x)); } return <p>Don't panic</p>; }\nfunction onChange(x) { return String(x).includes('a'); }\n// 11 string literal mentioning the bad pattern\nit('never uses String(err).includes for classification', () => {});\n",
      },
      expect: {"exit": 0, "fail": [], "warn": ["src/a.tsx:10", "src/a.tsx:11", "src/a.tsx:28"]},
    },
    {
      name: "review false positives: JSX Can't, quote in a regex literal, test title, Node callback, loop variable",
      files: {
        "src/b.tsx": "try { a(); } catch (x) { setMsg(<p>Can't save</p>); }\nfunction onChange(x) { return String(x).includes('a'); }\n",
        "src/c.js": "try { a(); } catch (e) { if (/'/.test(errText(e))) q(); }\nfunction onKey(e) { return String(e).includes('Enter'); }\n",
        "src/d.test.js": "it('flags String(err).includes(x) in classifiers', () => {});\n",
        "src/e.js": "fs.readFile(p, (err, data) => { if (String(err).includes('ENOENT')) return null; });\nfor (const ex of examples) { if (String(ex).startsWith('demo')) run(ex); }\n",
      },
      expect: {"exit": 0, "fail": [], "warn": ["src/e.js:1"]},
    },
    {
      name: "review false negatives: implicit coercion, concatenation, ?.toString, JSON.stringify, as-cast, templates, typed params",
      files: {
        "src/f.js": "try { a(); } catch (e) { if (/network/i.test(e)) q(); }\ntry { a(); } catch (e) { if (NET_RE.test(e)) q(); }\ntry { a(); } catch (e) { if ((e + '').includes('Failed')) q(); }\ntry { a(); } catch (e) { if (('' + e).includes('Failed')) q(); }\ntry { a(); } catch (e) { if (e?.toString().includes('Failed')) q(); }\ntry { a(); } catch (e) { if (JSON.stringify(e).includes('Failed')) q(); }\ntry { a(); } catch (e) { if (String(e as Error).includes('Failed')) q(); }\ntry { a(); } catch (e) { if (`Error: ${e}`.includes('Failed')) q(); }\ntry { a(); } catch (e) { if (String(e)\n    .includes('Failed')) q(); }\ntry { a(); } catch ({ message }) { q(message); }\nfunction isRetryable(err: unknown) { return /fetch/.test(String(err)); }\nconst isNet = (e: unknown) => String(e).includes('Network');\n",
      },
      expect: {"exit": 1, "fail": ["src/f.js:1", "src/f.js:2", "src/f.js:3", "src/f.js:4", "src/f.js:5", "src/f.js:6", "src/f.js:7", "src/f.js:8", "src/f.js:9", "src/f.js:12", "src/f.js:13"], "warn": []},
    },
    {
      name: "stringified but not matched: WARN only",
      files: {
        "src/w.js": "try{a()}catch(e){log(String(e))}\n",
      },
      expect: {"exit": 0, "fail": [], "warn": ["src/w.js:1"]},
    },
    {
      name: "suppression with a reason is honoured; a stale one is listed",
      files: {
        "src/s.js": "// neterr-ok(stringified-error): stale reason\nconst a = 1;\ntry{a()}catch(e){\n  // neterr-ok(stringified-classify): sanctioned for test\n  if (String(e).includes(\"x\")) q();\n}\n",
      },
      expect: {"exit": 0, "fail": [], "warn": [], "unused": 1, "suppressed": 1},
    },
    {
      name: "shipped defects: dead queue, errText leak, one-way duplicate guard, bare suppression",
      files: {
        "src/lib/net-errors.js": "// Defect 2: errText({}) leaked \"[object Object]\".\nexport function errText(err) {\n  if (err instanceof Error) return err.message;\n  return err == null ? '' : String(err);\n}\n// Defect 3: matched only the open duplicate.\nexport function isAlreadyRecorded(err) {\n  return /already opened/i.test(errText(err));\n}\n// Defect 1 (DOA queue): String(err) on a plain-object rejection.\nexport function isRetryable(err) {\n  return /NETWORK_TIMEOUT|Network request failed|fetch failed|Failed to fetch/i.test(String(err));\n}\n",
        "src/lib/drain.js": "export async function drain(send) {\n  try {\n    await send();\n  } catch (e) {\n    if (/Network request failed/.test(String(e))) return 'wait';\n    if (String(e).toLowerCase().includes('timeout')) return 'wait';\n    const msg = e instanceof Error ? e.message : '';\n    console.warn(`drain failed: ${e}`);\n    return msg;\n  }\n}\nexport const probe = (p) => p.catch((reason) => `${reason}`.includes('offline'));\n// neterr-ok(stringified-error)\nexport const label = (err) => String(err);\n",
      },
      config: {"dirs": ["src"], "module": "src/lib/net-errors.js", "presets": ["fetch", "postgrest"], "timeoutError": "NETWORK_TIMEOUT: save (20s)", "cases": [{"label": "duplicate open", "value": {"$error": "Already opened at this site"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate CLOSE, the one that wedged the queue", "value": {"$error": "Already closed"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate as a plain object", "value": {"message": "Already closed", "code": ""}, "retryable": false, "alreadyRecorded": true}]},
      expect: {"exit": 1, "fail": ["src/lib/drain.js:5", "src/lib/drain.js:6", "src/lib/drain.js:12", "src/lib/drain.js:13"], "warn": ["src/lib/drain.js:7", "src/lib/drain.js:8", "src/lib/drain.js:14"], "fixture": 7},
    },
    {
      name: "fixed module and callers pass",
      files: {
        "src/lib/net-errors.js": "export function errText(err) {\n  if (err instanceof Error) return err.message;\n  if (err && typeof err === 'object') return 'message' in err ? String(err.message ?? '') : '';\n  return err == null ? '' : String(err);\n}\nexport function isAlreadyRecorded(err) {\n  return /already (opened|closed)/i.test(errText(err));\n}\nexport function isRetryable(err) {\n  if (/NETWORK_TIMEOUT|Network request failed|fetch failed|Failed to fetch/i.test(errText(err))) return true;\n  return !!err && typeof err === 'object' && err.status === 0;\n}\n",
        "src/lib/drain.js": "import { errText, isRetryable } from './net-errors.js';\nexport async function drain(send) {\n  try {\n    await send();\n  } catch (e) {\n    if (isRetryable(e)) return 'wait';\n    // e here is an event-name string from our own emitter, never a rejection.\n    return errText(e);\n  }\n}\nexport const probe = (p) => p.catch((reason) => errText(reason).includes('offline'));\n// neterr-ok(stringified-error): the value is a numeric id, never a rejection\nexport const label = (err) => String(err);\n// e is a DOM event here, not a caught error: must not be flagged.\nexport const onKey = (e) => String(e).includes('Enter');\n",
      },
      config: {"dirs": ["src"], "module": "src/lib/net-errors.js", "presets": ["fetch", "postgrest"], "timeoutError": "NETWORK_TIMEOUT: save (20s)", "cases": [{"label": "duplicate open", "value": {"$error": "Already opened at this site"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate CLOSE, the one that wedged the queue", "value": {"$error": "Already closed"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate as a plain object", "value": {"message": "Already closed", "code": ""}, "retryable": false, "alreadyRecorded": true}]},
      expect: {"exit": 0, "fail": [], "warn": [], "fixture": 0, "module": 0, "suppressed": 1},
    },
    {
      name: "re-injected: isRetryable over String(err)",
      files: {
        "src/lib/net-errors.js": "export function errText(err) {\n  if (err instanceof Error) return err.message;\n  if (err && typeof err === 'object') return 'message' in err ? String(err.message ?? '') : '';\n  return err == null ? '' : String(err);\n}\nexport function isAlreadyRecorded(err) {\n  return /already (opened|closed)/i.test(errText(err));\n}\nexport function isRetryable(err) {\n  if (/NETWORK_TIMEOUT|Network request failed|fetch failed|Failed to fetch/i.test(String(err))) return true;\n  return !!err && typeof err === 'object' && err.status === 0;\n}\n",
      },
      config: {"dirs": ["src"], "module": "src/lib/net-errors.js", "presets": ["fetch", "postgrest"], "timeoutError": "NETWORK_TIMEOUT: save (20s)", "cases": [{"label": "duplicate open", "value": {"$error": "Already opened at this site"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate CLOSE, the one that wedged the queue", "value": {"$error": "Already closed"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate as a plain object", "value": {"message": "Already closed", "code": ""}, "retryable": false, "alreadyRecorded": true}]},
      expect: {"exit": 1, "fixture": 2},
    },
    {
      name: "re-injected: errText({}) leaks String(obj)",
      files: {
        "src/lib/net-errors.js": "export function errText(err) {\n  if (err instanceof Error) return err.message;\n  if (err && typeof err === 'object') return 'message' in err ? String(err.message ?? '') : String(err);\n  return err == null ? '' : String(err);\n}\nexport function isAlreadyRecorded(err) {\n  return /already (opened|closed)/i.test(errText(err));\n}\nexport function isRetryable(err) {\n  if (/NETWORK_TIMEOUT|Network request failed|fetch failed|Failed to fetch/i.test(errText(err))) return true;\n  return !!err && typeof err === 'object' && err.status === 0;\n}\n",
      },
      config: {"dirs": ["src"], "module": "src/lib/net-errors.js", "presets": ["fetch", "postgrest"], "timeoutError": "NETWORK_TIMEOUT: save (20s)", "cases": [{"label": "duplicate open", "value": {"$error": "Already opened at this site"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate CLOSE, the one that wedged the queue", "value": {"$error": "Already closed"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate as a plain object", "value": {"message": "Already closed", "code": ""}, "retryable": false, "alreadyRecorded": true}]},
      expect: {"exit": 1, "fixture": 1},
    },
    {
      name: "re-injected: duplicate guard matches one direction only",
      files: {
        "src/lib/net-errors.js": "export function errText(err) {\n  if (err instanceof Error) return err.message;\n  if (err && typeof err === 'object') return 'message' in err ? String(err.message ?? '') : '';\n  return err == null ? '' : String(err);\n}\nexport function isAlreadyRecorded(err) {\n  return /already opened/i.test(errText(err));\n}\nexport function isRetryable(err) {\n  if (/NETWORK_TIMEOUT|Network request failed|fetch failed|Failed to fetch/i.test(errText(err))) return true;\n  return !!err && typeof err === 'object' && err.status === 0;\n}\n",
      },
      config: {"dirs": ["src"], "module": "src/lib/net-errors.js", "presets": ["fetch", "postgrest"], "timeoutError": "NETWORK_TIMEOUT: save (20s)", "cases": [{"label": "duplicate open", "value": {"$error": "Already opened at this site"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate CLOSE, the one that wedged the queue", "value": {"$error": "Already closed"}, "retryable": false, "alreadyRecorded": true}, {"label": "duplicate as a plain object", "value": {"message": "Already closed", "code": ""}, "retryable": false, "alreadyRecorded": true}]},
      expect: {"exit": 1, "fixture": 2},
    },
    {
      name: "module that throws at import",
      files: {
        "src/n.mjs": "throw new Error('boom at import');\n",
      },
      config: {"module": "src/n.mjs", "timeoutError": "T"},
      expect: {"exit": 1, "module": 1},
    },
    {
      name: "errText({}) reads \"undefined\"",
      files: {
        "src/n.mjs": "export const errText = (e) => (e && typeof e === 'object' ? String(e.message) : typeof e === 'string' ? e : '');\nexport const isRetryable = (e) => e && (e.status === 0 || /fetch|network|NETWORK_TIMEOUT/i.test(errText(e)));\n",
      },
      config: {"module": "src/n.mjs", "timeoutError": "NETWORK_TIMEOUT: x", "presets": ["fetch", "postgrest"]},
      expect: {"exit": 1, "fixture": 1, "module": 0},
    },
    {
      name: "module that needs a transform (enum) with no tsc",
      files: {
        "src/n.ts": "enum K { A }\nexport const isRetryable = (e: unknown) => false;\n",
      },
      config: {"module": "src/n.ts", "timeoutError": "T"},
      expect: {"exit": 1, "module": 1},
    },
    {
      name: "unresolved scope (unbalanced braces) downgrades to WARN; a rebound name stops proving",
      files: {
        "src/u.js": "try { a(); } catch (e) {\n  if (String(e).includes('x')) q();\n",
        "src/r.js": "try { a(); } catch (e) {\n  if (String(e).includes('x')) q();\n  const e2 = 1; list.map(function (e) { return String(e).includes('y'); });\n}\n",
      },
      expect: {"exit": 1, "fail": ["src/r.js:2"], "warn": ["src/r.js:3", "src/u.js:2"]},
    },
    {
      name: "typed parameters: an error-named unknown is proven, a value-named unknown is not",
      files: {
        "src/t.ts": "export function fmt(val: unknown) { return String(val).includes('T'); }\nexport async function put(value: unknown) { await store(JSON.stringify(value)); }\nexport const isGone = (reason: unknown): boolean => JSON.stringify(reason).includes('404');\n",
      },
      expect: {"exit": 1, "fail": ["src/t.ts:3"], "warn": []},
    },
    {
      name: "round-2 review: regex after =>, unclosed JSX quotes, nested templates, destructuring, class getters",
      files: {
        "src/a/arrowq.ts": "function C() {\n  try { a(); } catch (e) { ok = names.some((n) => /'/.test(n)); }\n  let a1, e = id;\n  return `${e}`.endsWith('7');\n}\n",
        "src/a/cls.ts": "class K {\n  get error(): string { return this._e; }\n  check() { return String(this.error).includes('x'); }\n  handle(e: unknown) { return errText(e).includes('x'); }\n  parse = <T,>(e: unknown) => JSON.stringify(e).length;\n}\ntry { a(); } catch ({ message }) { if (String(message).includes('x')) q(); }\n",
        "src/a/jsx.tsx": "function A() {\n  try { a(); } catch (x) { setMsg(<p>Users' data was kept</p>); }\n  const { x } = pos;\n  return String(x).startsWith('1');\n}\n",
        "src/a/tpl.ts": "function D() {\n  try { a(); } catch (e) { log(`${ok ? `it's ${n}` : `}`}`); }\n  const { e } = ev;\n  return String(e).includes('x');\n}\n",
        "src/a/url.ts": "function B() {\n  try { a(); } catch (e) { list.filter((u) => /https?:\\/\\//.test(u)); }\n  const [e] = parts;\n  return String(e).includes('x');\n}\n",
        "src/b/arrowq.ts": "function C() {\n  try { a(); } catch (e) { ok = names.some((n) => /'/.test(n)); }\n  return `${e}`.endsWith('7');\n}\n",
        "src/b/jsx.tsx": "function A() {\n  try { a(); } catch (x) { setMsg(<p>Users' data was kept</p>); }\n  return String(x).startsWith('1');\n}\n",
        "src/b/url.ts": "function B() {\n  try { a(); } catch (e) { list.filter((u) => /https?:\\/\\//.test(u)); }\n  return String(e).includes('x');\n}\n",
        "src/url.ts": "function B(e) {\n  try { a(); } catch (e) { ok = (u) => /https?:\\/\\//.test(u); }\n  return String(e).includes('x');\n}\n",
        "src/dq.tsx": "export function Help({ e }) {\n  try { load(); } catch (e) { tip = <i>Press \"Enter</i>; }\n  return String(e).includes('Enter');\n}\n",
        "src/jsx.tsx": "function A({ x }) {\n  try { a(); } catch (e) { msg = <p>Users' data was kept</p>; }\n  return <Row>{String(e).includes('1') ? 'a' : 'b'}</Row>;\n}\n",
      },
      expect: {"exit": 0, "fail": [], "warn": ["src/a/cls.ts:5", "src/a/jsx.tsx:4", "src/b/jsx.tsx:3", "src/dq.tsx:3", "src/jsx.tsx:3"]},
    },
    {
      name: "typed-parameter names match by segment; e/ex/reason/cause are proven only under unknown; template-first arrow bodies",
      files: {
        "src/ref.ts": "export const fromSearch = (referrer: unknown) => String(referrer).includes('google');\nexport function isLand(terrain: any) { return `${terrain}`.startsWith('land'); }\nexport const isAbort = (interrupt: unknown) => String(interrupt).includes('abort');\nexport function k(e: KeyboardEvent | unknown) { return String(e).includes('x'); }\n",
        "src/seg.ts": "export const isNet = (fetchErr: unknown) => String(fetchErr).includes('Network');\n",
        "src/j.tsx": "export function P({ e }) {\n  try { a(); } catch (e) { r = <p>{n}/{m} {ok && x}</p>; }\n  return String(e).includes('x');\n}\nexport function Q({ e }) {\n  try { a(); } catch (e) { r = <p>{n}/2 rows}</p>; }\n  return String(e).includes('x');\n}\n",
        "src/j2.tsx": "export function S({ e }) {\n  try { a(); } catch (e) { r = <p>{n}/{m} rows; }\n  return String(e).includes('x');\n}\n",
        "src/m.ts": "export const sci = (e: any) => String(e).includes('e+');\nexport function isInfectious(cause: any) { return String(cause).startsWith('A0'); }\nexport const isOther = (reason: any) => `${reason}`.includes('other');\nexport function onReject(reason: unknown) { return String(reason).includes('x'); }\ntry { a(); } catch (e) { log(`failed: ${e}`); console.error(`[sync] ${e}`, e); }\ntry { a(); } catch (e) { if (matches(String(e), /net/)) q(); expect(String(e)).toContain('x'); }\ntry { a(); } catch (e) { if (JSON.stringify(e).length > 2) q(); }\n",
      },
      expect: {"exit": 1, "fail": ["src/m.ts:4", "src/seg.ts:1"], "warn": ["src/j2.tsx:3", "src/m.ts:1", "src/m.ts:2", "src/m.ts:3", "src/m.ts:5", "src/m.ts:5", "src/m.ts:6", "src/m.ts:6", "src/m.ts:7"]},
    },
    {
      name: "nothing to check",
      files: {
        "README.md": "no source here\n",
      },
      expect: {"exit": 0, "checked": false},
    },
  ];
}
