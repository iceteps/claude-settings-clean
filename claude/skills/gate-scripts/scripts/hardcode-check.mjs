#!/usr/bin/env node
/**
 * hardcode-check.mjs   ·   wired as: "hardcode:check": "node scripts/hardcode-check.mjs"
 *
 * The i18n GUARD GATE. Encodes the lenses of a translation-readiness audit as a
 * fast, dependency-free scanner so those violation classes can never silently
 * return.
 *
 * FAIL classes (exit 1):
 *   jsx-text          bare JSX text nodes with words (Latin or Hebrew)
 *   prop-literal      hardcoded user-visible string props (placeholder=, label=, …)
 *   alert-literal     quoted prose inside showAlert / Alert.alert / confirmAction
 *   validator-literal prose messages inside schema validators (.min(1, 'Name is required'))
 *   raw-error         e.message / err.message fed to showAlert / Alert.alert / setXxx
 *   errtext-display   a raw-error-text helper (config: errtextDisplay.fns) used as
 *                     the user-facing message — a dialog argument or JSX text.
 *                     Such a helper is for CLASSIFICATION; display goes through
 *                     errorMessage(err, t, fallbackKey). Off unless configured.
 *   locale-branch     binary-locale code outside src/i18n (locale === 'he', 'he-IL', 'en-GB')
 *   locale-format     .toLocale*String with device locale or a literal tag outside src/i18n
 *   throw-sentence    throw new Error('Prose with spaces') — errors must be CODES
 *   kit-copy          an inline-copy helper (config: kitCopy.helper, e.g. `_('en','he')`)
 *                     outside the files allowed to carry it. Off unless configured.
 *
 * WARN classes (advisory, exit 0):
 *   template-glue     letter-words glued around ${t(...)} in a template literal
 *   fallback-literal  ?? 'Prose' / || 'Prose' fallbacks in .tsx
 *   plural-hack       en.ts values containing '(s)'
 *
 * RATCHETS. throw-sentence, errtext-display and kit-copy each accept a frozen
 * baseline from config (see gate-config.json below and ../ratchet.md): what is
 * listed passes, anything NEW fails, and the lists may only shrink.
 *
 * Suppression grammar — one line, one (comma-separated) class list, with a reason:
 *   // hardcode-ok(locale-format): CSV pins en-GB as a machine format
 * A comment-only line suppresses the NEXT line; a trailing comment suppresses
 * its OWN line. Inside JSX, use the brace-comment form on its own line.
 * Unused suppressions are reported so they cannot rot in place.
 *
 * Usage: node scripts/hardcode-check.mjs [root]   (root defaults to src)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const SRC = process.argv[2] || 'src';

/** Locale VALUE files — they ARE the strings. index.ts stays scanned (it is
 *  consumer code), but classes locale-branch/locale-format skip all of src/i18n
 *  (that is where localeTag/RTL_LOCALES are DEFINED). */
const LOCALE_FILE_RE = /(^|\/)i18n\/(?!index\.ts$)[a-z]{2,3}(-[A-Za-z0-9]+)?\.ts$/;
// The locale layer itself is exempt from locale-branch/locale-format — it is
// where that logic BELONGS. The app expresses it as a directory (src/i18n/),
// the web as a single module (web/src/lib/i18n.tsx); both are the same role.
const inI18nDir = (rel) => /(^|\/)i18n\//.test(rel) || /(^|\/)i18n\.tsx?$/.test(rel);

/* ── per-project config ──────────────────────────────────────────────────────
   Project specifics (baselines, allowlists, helper names) live in JSON, never in
   this script. A repo-committed `.claude/gate-config.json` wins (a repo that
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
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const { path: CONFIG_PATH, cfg: CONFIG } = loadGateConfig('hardcode', {
  /* throw-sentence ratchet: sentence throws that PRE-DATE the gate and are known
     to be mapped to a localized generic before display. Burn down by converting
     each to a stable code. Never add to it: a new sentence throw becomes a code. */
  legacyThrows: isStrList,
  /* errtext-display: { fns: ['errText'], baseline: { 'path/file.tsx': ['err'] } }.
     fns names the helpers that read a backend message's raw text; baseline maps
     file → the argument identifier of each display slot that pre-dates the gate,
     ONE ENTRY PER SLOT (a multiset: two baselined errText(err) slots in one file
     are ['err', 'err'], so a third copy pasted beside them still fails). */
  errtextDisplay: (v) => isObj(v) && isStrList(v.fns ?? []) && (v.fns ?? []).every((f) => /^[\w$]+$/.test(f))
    && isObj(v.baseline ?? {})
    && Object.values(v.baseline ?? {}).every(isStrList)
    && Object.keys(v).every((k) => ['fns', 'baseline'].includes(k) || k.startsWith('//')),
  /* kit-copy: { helper: '_', allow: [...], baseline: [...] }. EXPLICIT file paths,
     never a directory glob — a glob silently admits the next file added under it.
     allow = permanent homes (the helper's own module, sample/fixture copy);
     baseline = product files that pre-date the gate, to burn down. */
  kitCopy: (v) => isObj(v) && typeof v.helper === 'string' && /^[\w$]+$/.test(v.helper)
    && isStrList(v.allow ?? []) && isStrList(v.baseline ?? [])
    && Object.keys(v).every((k) => ['helper', 'allow', 'baseline'].includes(k) || k.startsWith('//')),
});

const LEGACY_THROW_SENTENCES = new Set(CONFIG.legacyThrows ?? []);

const ERRTEXT_FNS = CONFIG.errtextDisplay?.fns ?? [];
/** `${file}::${arg}` → slots still allowed; decremented as slots are met, so
 *  whatever is left over at the end is a STALE row. */
const errtextAllowance = new Map();
for (const [f, ids] of Object.entries(CONFIG.errtextDisplay?.baseline ?? {})) {
  for (const id of ids) errtextAllowance.set(`${f}::${id}`, (errtextAllowance.get(`${f}::${id}`) ?? 0) + 1);
}

const KIT_COPY = CONFIG.kitCopy ?? null;
const KIT_COPY_ALLOW = new Set(KIT_COPY?.allow ?? []);
const KIT_COPY_BASELINE = new Set(KIT_COPY?.baseline ?? []);
// `_(` where `_` is a standalone identifier — never `foo_(`, `x._(`, `[_, y]`.
const KIT_COPY_RE = KIT_COPY ? new RegExp(`(?<![\\w$.])${KIT_COPY.helper.replace(/\$/g, '\\$')}\\s*\\(`, 'g') : null;

const WORD = /[A-Za-z\u0590-\u05FF]{2,}/;
const CODE_MSG = /^[A-Z][A-Z0-9_]*(:.*)?$/s; // SCREAMING_SNAKE code, optional ': detail' log suffix
const HOOK_GUARD = /^use[A-Z]\w* must be used within /; // standard React context-guard idiom (dev-only)
const I18N_KEY_SHAPE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/; // 'screen.element' — a t() key, not prose

/* ── file walk ───────────────────────────────────────────────────────────── */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (['.ts', '.tsx'].includes(extname(full)) && !/\.(test|spec)\./.test(entry)) out.push(full);
  }
  return out;
}

/* ── views: comment-stripped, and string-blanked (for JSX text) ──────────── */

/**
 * String-aware single pass. Comments → spaces always; with blankStrings, the
 * CONTENTS of '…' / "…" / `…` (outside ${…}) become spaces too, so quoted code
 * like 'a > b < c' can never fake a JSX text node. Length is preserved, so
 * indexes and line numbers stay true.
 */
function makeView(src, { blankStrings }) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
    } else if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < n) { blank(i); blank(i + 1); i += 2; }
    } else if (c === "'" || c === '"') {
      i++; // keep the quote char
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { if (blankStrings) blank(i); i++; }
        if (i < n && src[i] !== c && src[i] !== '\n') { if (blankStrings) blank(i); i++; }
      }
      i++; // closing quote (or newline — unterminated, bail to normal)
    } else if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { if (blankStrings) blank(i); i++; if (blankStrings && i < n) blank(i); i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // interpolation: recurse via depth counting, contents stay code
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (blankStrings) blank(i);
        i++;
      }
      i++; // closing backtick
    } else {
      i++;
    }
  }
  return out.join('');
}

/* ── suppressions ────────────────────────────────────────────────────────── */

const SUPPRESS_RE = /hardcode-ok\(\s*([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*\)/;

/** Sanctioned alternate SPELLINGS per class. `hardcode-ok(errtext-diagnostic)`
 *  waives an errtext-display finding under the name of the pattern being
 *  invoked (a small untranslated diagnostic detail line under a retry
 *  affordance), which is what a reviewer should read at the call site — not
 *  just "silence this class". */
const SUPPRESS_ALIASES = { 'errtext-display': ['errtext-diagnostic'] };

/** The suppression on `line` covering `cls` (or one of its aliases), else null. */
function supMatch(suppressions, line, cls) {
  const s = suppressions.get(line);
  if (!s) return null;
  const ok = s.classes.has(cls) || (SUPPRESS_ALIASES[cls] ?? []).some((a) => s.classes.has(a));
  return ok ? s : null;
}

/** Map<lineNumber, { classes:Set<string>, declLine:number }> from RAW source. */
function parseSuppressions(rawLines) {
  const map = new Map();
  rawLines.forEach((line, idx) => {
    const m = SUPPRESS_RE.exec(line);
    if (!m) return;
    const classes = new Set(m[1].split(',').map((s) => s.trim()));
    const declLine = idx + 1;
    // comment-only line (//… or {/*…) → guards the NEXT line; trailing → its own
    const target = /^\s*(\/\/|\/\*|\{\s*\/\*)/.test(line) ? declLine + 1 : declLine;
    const existing = map.get(target);
    if (existing) for (const c of classes) existing.classes.add(c);
    else map.set(target, { classes, declLine, used: false });
  });
  return map;
}

/* ── findings plumbing ───────────────────────────────────────────────────── */

const errors = [];
const warnings = [];
const legacyThrows = [];
const legacyThrowsSeen = new Set();
const errtextBaseline = [];
const kitCopyBaseline = [];
const kitCopyBaselineSeen = new Set(); // file
let suppressedCount = 0;

function report(level, file, line, cls, msg, text, suppressions) {
  const sup = supMatch(suppressions, line, cls);
  if (sup) {
    sup.used = true;
    suppressedCount++;
    return;
  }
  const hit = { file, line, rule: cls, msg, text: text.replace(/\s+/g, ' ').trim().slice(0, 90) };
  (level === 'error' ? errors : warnings).push(hit);
}

const lineOf = (code, idx) => {
  let line = 1;
  for (let i = 0; i < idx; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
};

/* ── class implementations ───────────────────────────────────────────────── */

// 1. jsx-text — runs on the string-BLANKED view of .tsx files.
//    A candidate is >…< where the '>' closes a real tag (preceded by a
//    tag-name char, quote, '}', ']' or '/'), the span contains no code
//    characters once {…} interpolations are removed, and a 2+ letter word
//    survives.
const JSX_SPAN_RE = /[\w"'’}\]/]>([^<>]*)</g;
const JSX_CODE_CHARS = /[=();&|`{}]/;
// digit-adjacent letter ('3h 05m', '5m ago') — unit glue is prose too.
const UNIT_GLUE = /\d\s*[A-Za-z\u0590-\u05FF]/;

function checkJsxText(view, rel, sup) {
  JSX_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = JSX_SPAN_RE.exec(view)) !== null) {
    JSX_SPAN_RE.lastIndex = m.index + m[0].length - 1; // '<' may open the next tag
    let span = m[1];
    // strip {expression} interpolations (blanked strings ⇒ braces are structural)
    let prev;
    do { prev = span; span = span.replace(/\{[^{}]*\}/g, ' '); } while (span !== prev);
    if (JSX_CODE_CHARS.test(span)) continue; // leftover code → not a text node
    if (!WORD.test(span) && !UNIT_GLUE.test(span)) continue;
    const line = lineOf(view, m.index + 1);
    report('error', rel, line, 'jsx-text',
      "bare JSX text node — user-visible words hardcoded in markup. Wrap in {t('key')} (add the key to BOTH en.ts and he.ts).",
      `>${m[1].trim()}<`, sup);
  }
  // <>Fragment bare text</> — '<' can't join the main preceding-char class
  // (it would over-match comparisons), so fragments get their own pass.
  const FRAG_RE = /<>\s*([^<>]*)</g;
  FRAG_RE.lastIndex = 0;
  while ((m = FRAG_RE.exec(view)) !== null) {
    let span = m[1];
    let prev;
    do { prev = span; span = span.replace(/\{[^{}]*\}/g, ' '); } while (span !== prev);
    if (JSX_CODE_CHARS.test(span)) continue;
    if (!WORD.test(span) && !UNIT_GLUE.test(span)) continue;
    report('error', rel, lineOf(view, m.index + 1), 'jsx-text',
      "bare JSX text node — user-visible words hardcoded in markup. Wrap in {t('key')} (add the key to BOTH en.ts and he.ts).",
      `<>${m[1].trim()}<`, sup);
  }
}

// 2. prop-literal — .tsx only, comment-stripped view (strings intact).
const PROP_RE = /\b(placeholder|accessibilityLabel|aria-label|alt|label|title)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|\{\s*"([^"\n]*)"\s*\}|\{\s*'([^'\n]*)'\s*\}|\{\s*`([^`\n$]*)`\s*\})/g;

function checkPropLiterals(code, rel, sup) {
  PROP_RE.lastIndex = 0;
  let m;
  while ((m = PROP_RE.exec(code)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '';
    if (!WORD.test(value)) continue;
    report('error', rel, lineOf(code, m.index), 'prop-literal',
      `hardcoded user-visible ${m[1]} — use ${m[1]}={t('key')} (key in BOTH en.ts and he.ts).`,
      m[0], sup);
  }
}

// 3. alert-literal — balanced-paren spans of showAlert( / Alert.alert( /
//    confirmAction(, flagging quoted prose as a direct argument or in a
//    user-facing field (title/message/confirmLabel/cancelLabel/text).
function callSpans(code, callRe) {
  const spans = [];
  callRe.lastIndex = 0;
  let m;
  while ((m = callRe.exec(code)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < code.length && depth > 0) {
      const c = code[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    spans.push([m.index, j]);
  }
  return spans;
}

const ALERT_CALL_RE = /\b(?:showAlert|Alert\.alert|confirmAction)\s*\(/g;
const ALERT_FIELD_RE = /(?:[(,]\s*|\b(?:title|message|confirmLabel|cancelLabel|text)\s*:\s*)(['"])((?:(?!\1).)+)\1/g;

function checkAlertLiterals(code, rel, sup) {
  for (const [a, b] of callSpans(code, ALERT_CALL_RE)) {
    const seg = code.slice(a, b);
    ALERT_FIELD_RE.lastIndex = 0;
    let f;
    while ((f = ALERT_FIELD_RE.exec(seg)) !== null) {
      const value = f[2];
      if (!WORD.test(value)) continue;
      if (I18N_KEY_SHAPE.test(value)) continue; // t('screen.key') / errorMessage(e, t, 'key')
      if (/^[A-Z0-9_]+$/.test(value)) continue; // stable error CODE (raw.includes('ENTRY_CHANGED'))
      report('error', rel, lineOf(code, a + f.index), 'alert-literal',
        "quoted prose in showAlert/Alert.alert/confirmAction — dialogs must use t('key') (and showAlert over bare Alert.alert: silent no-op on web).",
        f[0], sup);
    }
    // Template-literal prose in dialogs: showAlert(`Something went wrong`).
    const TICK_RE = /`((?:[^`\\]|\\.)*)`/g;
    TICK_RE.lastIndex = 0;
    let tk;
    while ((tk = TICK_RE.exec(seg)) !== null) {
      let residue = tk[1];
      let prev;
      do { prev = residue; residue = residue.replace(/\$\{[^{}]*\}/g, ' '); } while (residue !== prev);
      if (!WORD.test(residue)) continue;
      if (I18N_KEY_SHAPE.test(residue) || /^[A-Z0-9_\s:]+$/.test(residue.trim())) continue;
      report('error', rel, lineOf(code, a + tk.index), 'alert-literal',
        "template-literal prose in showAlert/Alert.alert/confirmAction — dialogs must use t('key').",
        tk[0], sup);
    }
  }
}

// 3b. validator-literal — prose messages inside schema validators
// (z.string().min(1, 'Name is required') renders verbatim under inputs).
const VALIDATOR_RE = /\.(?:min|max|length|email|url|uuid|regex|nonempty|refine)\(\s*[^,()]*,\s*(['"])((?:(?!\1).)+)\1/g;

function checkValidatorLiterals(code, rel, sup) {
  VALIDATOR_RE.lastIndex = 0;
  let m;
  while ((m = VALIDATOR_RE.exec(code)) !== null) {
    const value = m[2];
    // prose-shaped: a word plus a space — 'Name is required', not a flag or code
    if (!(WORD.test(value) && /\s/.test(value))) continue;
    report('error', rel, lineOf(code, m.index), 'validator-literal',
      "prose message inside a schema validator — it renders verbatim to users. Render t('key') from the field error state instead.",
      m[0], sup);
  }
}

// 4. raw-error — <err-ish>.message inside showAlert(…) / Alert.alert(…) / setXxx(…).
const SETTER_CALL_RE = /\b(?:showAlert|Alert\.alert|set(?!Timeout|Interval|Immediate)[A-Z]\w*)\s*\(/g;
const MSG_RECEIVER_RE = /\b([A-Za-z_$][\w$]*)\.message\b/g;
// e / ex / err-rooted identifiers (err, error, photosErrorObj) — but NOT mere
// 'err' substrings like 'preferred' or 'interrupted'.
const ERRISH = /^(e|ex)$|(^|[^a-z])err/i;

function checkRawError(code, rel, sup) {
  for (const [a, b] of callSpans(code, SETTER_CALL_RE)) {
    const seg = code.slice(a, b);
    MSG_RECEIVER_RE.lastIndex = 0;
    let m;
    while ((m = MSG_RECEIVER_RE.exec(seg)) !== null) {
      if (!ERRISH.test(m[1])) continue;
      report('error', rel, lineOf(code, a + m.index), 'raw-error',
        'raw error.message shown to the user — backend/SDK errors speak English. Route through the project errorMessage(e, t, fallbackKey) helper.',
        code.slice(a, a + seg.indexOf(')') + 1) || m[0], sup);
    }
  }
}

// 4b. errtext-display — a raw-error-text helper (errtextDisplay.fns, e.g.
//     errText) in a DISPLAY position: an argument inside showAlert(…) /
//     Alert.alert(…) / confirmAction(…), or rendered as JSX text. Such a helper
//     reads a backend/SDK message STRUCTURALLY — the right tool for
//     CLASSIFICATION (raw.includes('SOME_CODE')), predicates and log lines — but
//     the string it returns is the machine's raw English. As the PRIMARY
//     user-facing message it must be errorMessage(err, t, fallbackKey).
//     Classification reads belong on a hoisted `const raw = errText(e)`, which
//     this check deliberately does not match.
//     Runs on the string-BLANKED view: the call is code and survives; string
//     contents and comments cannot fake a hit, and paren-depth spans cannot be
//     derailed by a ')' inside a message literal.
const ERRTEXT_CALL_RE = ERRTEXT_FNS.length
  ? new RegExp(`(?<![\\w$])(?:${ERRTEXT_FNS.map((f) => f.replace(/\$/g, '\\$')).join('|')})\\s*\\(\\s*([\\w$.]*)`, 'g')
  : null;
const ERRTEXT_MSG =
  `${ERRTEXT_FNS.join('/')}(...) displayed to the user — it returns the backend/SDK's raw English. ` +
  'Display goes through errorMessage(err, t, fallbackKey); classification hoists ' +
  '`const raw = <helper>(e)` first. The one sanctioned diagnostic slot ' +
  '(an untranslated detail line under a retry affordance) suppresses with hardcode-ok(errtext-diagnostic).';

function errTextHits(text) {
  const hits = [];
  ERRTEXT_CALL_RE.lastIndex = 0;
  let m;
  while ((m = ERRTEXT_CALL_RE.exec(text)) !== null) hits.push({ idx: m.index, arg: m[1] });
  return hits;
}

function checkErrTextDisplay(blanked, rel, isTsx, sup) {
  if (!ERRTEXT_CALL_RE) return;
  const found = [];
  // (a) dialog argument position
  for (const [a, b] of callSpans(blanked, ALERT_CALL_RE)) {
    for (const h of errTextHits(blanked.slice(a, b))) found.push({ at: a + h.idx, arg: h.arg });
  }
  // (b) JSX text position — {errText(...)} as an element/fragment child (same
  //     span shape as jsx-text; interpolation braces stay structural here).
  if (isTsx) {
    for (const re of [/[\w"'’}\]/]>([^<>]*)</g, /<>([^<>]*)</g]) {
      let m;
      while ((m = re.exec(blanked)) !== null) {
        re.lastIndex = m.index + m[0].length - 1; // '<' may open the next tag
        const spanStart = m.index + m[0].length - 1 - m[1].length;
        for (const h of errTextHits(m[1])) found.push({ at: spanStart + h.idx, arg: h.arg });
      }
    }
  }
  for (const f of found) {
    const line = lineOf(blanked, f.at);
    // An inline suppression WINS over the baseline, so moving a slot to its
    // in-file hardcode-ok(errtext-diagnostic) before its baseline row is
    // deleted cannot surface as an "unused suppression".
    const slot = `${rel}::${f.arg}`;
    if (!supMatch(sup, line, 'errtext-display') && (errtextAllowance.get(slot) ?? 0) > 0) {
      errtextAllowance.set(slot, errtextAllowance.get(slot) - 1);
      errtextBaseline.push({ file: rel, line });
      continue;
    }
    const eol = blanked.indexOf('\n', f.at);
    report('error', rel, line, 'errtext-display', ERRTEXT_MSG,
      blanked.slice(f.at, Math.min(eol === -1 ? f.at + 60 : eol, f.at + 60)), sup);
  }
}

// 5. locale-branch — outside src/i18n only.
const LOCALE_BRANCH_RES = [
  /\blocale\s*[!=]==?\s*['"]he['"]/g,
  /['"]he['"]\s*[!=]==?\s*locale\b/g,
  /\blocale\.startsWith\(\s*['"]he/g,
  /['"](?:he-IL|en-GB)['"]/g,
];

function checkLocaleBranch(code, rel, sup) {
  for (const re of LOCALE_BRANCH_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      report('error', rel, lineOf(code, m.index), 'locale-branch',
        "binary-locale logic outside src/i18n — a third locale (ar/ru) breaks it silently. Use localeTag(locale) / RTL_LOCALES / LOCALE_META from '@/i18n'.",
        m[0], sup);
    }
  }
}

// 6. locale-format — .toLocale*String( whose first arg is absent, [], or a
//    literal tag. An identifier arg (locale, localeTag(locale), opts.locale) passes.
const LOCALE_FORMAT_RE = /\.toLocale(?:Date|Time)?String\(\s*(?=[)'"`[]|undefined\b)/g;

function checkLocaleFormat(code, rel, sup) {
  LOCALE_FORMAT_RE.lastIndex = 0;
  let m;
  while ((m = LOCALE_FORMAT_RE.exec(code)) !== null) {
    report('error', rel, lineOf(code, m.index), 'locale-format',
      'device-locale or literal-tag formatting — renders in the DEVICE language, not the app locale. Use fDate/fTime from useI18n(), or toLocale*String(localeTag(locale), …).',
      code.slice(m.index, m.index + 40), sup);
  }
}

// 7. throw-sentence.
const THROW_RE = /throw new Error\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;

function checkThrowSentence(code, rel, sup) {
  THROW_RE.lastIndex = 0;
  let m;
  while ((m = THROW_RE.exec(code)) !== null) {
    const msg = m[2];
    if (!msg.includes(' ')) continue; // single token — code-ish, fine
    if (CODE_MSG.test(msg)) continue; // 'NETWORK_TIMEOUT: create worksite' — code + log detail
    if (HOOK_GUARD.test(msg)) continue; // React context-guard idiom, dev-only
    const line = lineOf(code, m.index);
    // An inline suppression WINS over the baseline (ratchet.md rule 7): a site
    // moved to its own hardcode-ok(throw-sentence) must not read as unused.
    if (LEGACY_THROW_SENTENCES.has(msg) && !supMatch(sup, line, 'throw-sentence')) {
      legacyThrowsSeen.add(msg);
      legacyThrows.push({ file: rel, line, text: msg });
      continue;
    }
    report('error', rel, line, 'throw-sentence',
      "prose Error message — user-reachable errors must be stable CODES (throw new Error('SOME_CODE'), mapped to a translation key where errors are displayed; optional ': detail' suffix for logs).",
      m[0], sup);
  }
}

// 8. kit-copy — runs on the string-BLANKED view so a literal "_(" inside prose
//    (or a comment) can never fire. Off unless config declares kitCopy.
function checkKitCopy(view, rel, sup) {
  if (!KIT_COPY_RE || KIT_COPY_ALLOW.has(rel)) return;
  KIT_COPY_RE.lastIndex = 0;
  let m;
  while ((m = KIT_COPY_RE.exec(view)) !== null) {
    const line = lineOf(view, m.index);
    if (KIT_COPY_BASELINE.has(rel) && !supMatch(sup, line, 'kit-copy')) {
      kitCopyBaseline.push({ file: rel, line });
      kitCopyBaselineSeen.add(rel);
      continue;
    }
    report('error', rel, line, 'kit-copy',
      `inline \`${KIT_COPY.helper}(…)\` copy outside the files allowed to carry it — a label for REAL data must be t('key') with the key in every locale table, or key parity never sees it.`,
      m[0], sup);
  }
}

// WARN: template-glue — words glued around ${t(...)} in a template literal.
const TMPL_RE = /`(?:[^`\\]|\\.)*`/g;

function checkTemplateGlue(code, rel, sup) {
  TMPL_RE.lastIndex = 0;
  let m;
  while ((m = TMPL_RE.exec(code)) !== null) {
    const tmpl = m[0];
    if (!/\$\{\s*t\(/.test(tmpl)) continue;
    let residue = tmpl.slice(1, -1);
    // strip innermost {…} repeatedly (handles ${t('k', { v })} nesting), then stray '$'
    let prev;
    do { prev = residue; residue = residue.replace(/\{[^{}]*\}/g, ' '); } while (residue !== prev);
    residue = residue.replace(/\$/g, ' ');
    residue = residue.replace(/\.(?:csv|pdf|txt|json|ics|md|png|jpe?g|zip|xlsx?)\b/g, ' '); // file extensions
    if (!WORD.test(residue)) continue;
    report('warn', rel, lineOf(code, m.index), 'template-glue',
      "letter-words glued around ${t(...)} — concatenation breaks word order in other locales. Move the words into the key with a {{placeholder}}.",
      tmpl, sup);
  }
  // '+'-concatenation is the same word-order violation as template glue:
  // t('k') + ' items left'  /  'Total: ' + t('k')
  const CONCAT_RE = /\bt\(\s*'[^']+'[^)]*\)\s*\+\s*(['"])((?:(?!\1).)+)\1|(['"])((?:(?!\3).)+)\3\s*\+\s*\bt\(/g;
  CONCAT_RE.lastIndex = 0;
  let c;
  while ((c = CONCAT_RE.exec(code)) !== null) {
    const lit = c[2] ?? c[4] ?? '';
    if (!WORD.test(lit)) continue;
    report('warn', rel, lineOf(code, c.index), 'template-glue',
      "letter-words concatenated with t(...) — word order breaks in other locales. Move the words into the key with a {{placeholder}}.",
      c[0], sup);
  }
}

// WARN: fallback-literal — ?? 'Prose' / || 'Prose' in .tsx. Enum keys
// ('pending', 'personal') pass; prose (spaces, Hebrew, Capitalized word) warns.
const FALLBACK_RE = /(?:\?\?|\|\|)\s*(['"])((?:(?!\1).)+)\1/g;

function checkFallbackLiteral(code, rel, sup) {
  FALLBACK_RE.lastIndex = 0;
  let m;
  while ((m = FALLBACK_RE.exec(code)) !== null) {
    const v = m[2];
    if (!WORD.test(v)) continue;
    const prose = /[\u0590-\u05FF]/.test(v) || /[A-Za-z\u0590-\u05FF]{2,}\s+[A-Za-z\u0590-\u05FF]{2,}/.test(v) || /^[A-Z][a-z]+$/.test(v);
    if (!prose) continue;
    report('warn', rel, lineOf(code, m.index), 'fallback-literal',
      "hardcoded fallback prose after ??/|| — the fallback renders untranslated. Use t('key') as the fallback.",
      m[0], sup);
  }
}

// WARN: plural-hack — '(s)' inside en.ts values.
function checkPluralHacks() {
  const enPath = join(SRC, 'i18n', 'en.ts');
  let src;
  try { src = readFileSync(enPath, 'utf8'); } catch { return; }
  const re = /^\s*'([a-zA-Z0-9_.]+)'\s*:\s*(['"])([\s\S]*?)\2\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!m[3].includes('(s)')) continue;
    warnings.push({
      file: relative('.', enPath).split('\\').join('/'), line: lineOf(src, m.index), rule: 'plural-hack',
      msg: "'(s)' plural hack — Hebrew/Arabic/Russian plurals don't work that way. Use CLDR plural variants (key_one/key_two/key_other) with {{count}}.",
      text: `${m[1]}: '${m[3]}'`,
    });
  }
}

/* ── main pass ───────────────────────────────────────────────────────────── */

const files = walk(SRC);
const unusedSuppressions = [];

for (const file of files) {
  const rel = relative('.', file).split('\\').join('/');
  const isLocaleFile = LOCALE_FILE_RE.test(rel);
  const raw = readFileSync(file, 'utf8');
  const sup = parseSuppressions(raw.split('\n'));
  const code = makeView(raw, { blankStrings: false });
  const isTsx = rel.endsWith('.tsx');

  if (!isLocaleFile) {
    const blanked = makeView(raw, { blankStrings: true });
    checkKitCopy(blanked, rel, sup);
    if (isTsx) {
      checkJsxText(blanked, rel, sup);
      checkPropLiterals(code, rel, sup);
      checkFallbackLiteral(code, rel, sup);
    }
    checkAlertLiterals(code, rel, sup);
    checkValidatorLiterals(code, rel, sup);
    checkRawError(code, rel, sup);
    checkErrTextDisplay(blanked, rel, isTsx, sup);
    if (!inI18nDir(rel)) {
      checkLocaleBranch(code, rel, sup);
      checkLocaleFormat(code, rel, sup);
    }
    checkTemplateGlue(code, rel, sup);
  }
  checkThrowSentence(code, rel, sup);

  for (const [, s] of sup) {
    if (!s.used) unusedSuppressions.push({ file: rel, line: s.declLine });
  }
}

checkPluralHacks();

/* ── output ──────────────────────────────────────────────────────────────── */

const byRule = (list) => {
  const g = new Map();
  for (const h of list) {
    if (!g.has(h.rule)) g.set(h.rule, []);
    g.get(h.rule).push(h);
  }
  return g;
};

console.log(`hardcode check — scanned ${files.length} files in ${SRC}/` +
  (suppressedCount ? ` (${suppressedCount} finding(s) suppressed via hardcode-ok)` : ''));

/* Ratchet bookkeeping. A STALE row (its violation is gone) is reported so it
   is deleted: left in place it would silently re-admit that exact violation.
   File-keyed rows are judged only for files inside this run's root, since the
   gate runs once per source tree. legacyThrows is keyed by sentence, not file,
   so it reports coverage instead of staleness. */
const SRC_REL = relative('.', SRC).split('\\').join('/');
const inRun = (f) => SRC_REL === '' || f === SRC_REL || f.startsWith(`${SRC_REL}/`);
const cfgName = CONFIG_PATH ?? 'gate-config.json';
const staleRows = [
  ...[...errtextAllowance].filter(([slot, left]) => left > 0 && inRun(slot.split('::')[0]))
    .map(([slot, left]) => `hardcode.errtextDisplay.baseline: ${slot.replace('::', ' → ')}${left > 1 ? ` (×${left})` : ''}`),
  ...[...KIT_COPY_BASELINE].filter((f) => inRun(f) && !kitCopyBaselineSeen.has(f))
    .map((f) => `hardcode.kitCopy.baseline: ${f}`),
];

if (legacyThrows.length) {
  console.log(`ℹ  ${legacyThrows.length} legacy sentence throw(s) on the ratchet baseline (${cfgName} hardcode.legacyThrows, ${legacyThrowsSeen.size} of ${LEGACY_THROW_SENTENCES.size} listed sentences seen here) — convert to codes over time; new sentences FAIL.`);
}
if (errtextBaseline.length) {
  console.log(`ℹ  ${errtextBaseline.length} diagnostic slot(s) on the errtext-display ratchet baseline (${cfgName}) — move each to an inline hardcode-ok(errtext-diagnostic) and delete its row; new displays FAIL.`);
}
if (kitCopyBaseline.length) {
  console.log(`ℹ  ${kitCopyBaseline.length} inline-copy call(s) on the kit-copy ratchet baseline (${cfgName}) — promote the strings to t() keys and delete the file's row; new files FAIL.`);
}
if (staleRows.length) {
  console.log(`\n⚠  ${staleRows.length} STALE ratchet row(s) in ${cfgName} — the violation is gone; delete the row so it cannot come back:`);
  for (const r of staleRows) console.log(`   - ${r}`);
}

if (unusedSuppressions.length) {
  console.log(`\n⚠  ${unusedSuppressions.length} UNUSED hardcode-ok suppression(s) — the finding is gone, remove the comment:`);
  for (const u of unusedSuppressions) console.log(`   - ${u.file}:${u.line}`);
}

if (warnings.length) {
  const g = byRule(warnings);
  for (const [id, hits] of g) {
    console.log(`\n⚠  ${hits.length} ${id}`);
    console.log(`   ${hits[0].msg}`);
    for (const h of hits.slice(0, 12)) console.log(`   - ${h.file}:${h.line}  ${h.text}`);
    if (hits.length > 12) console.log(`   … and ${hits.length - 12} more`);
  }
  console.log('\nWarnings need a human call — they do not fail the build.');
}

if (errors.length) {
  const g = byRule(errors);
  console.error('');
  for (const [id, hits] of g) {
    console.error(`✖  ${hits.length} ${id}`);
    console.error(`   ${hits[0].msg}`);
    for (const h of hits) console.error(`   - ${h.file}:${h.line}  ${h.text}`);
    console.error('');
  }
  console.error(`✖ ${errors.length} hardcoded-string violation(s). Fix them (t() + en.ts/he.ts), or for a genuinely sanctioned case add: // hardcode-ok(<class>): <reason>`);
  process.exit(1);
}

console.log('✓ no hardcoded-string violations');
