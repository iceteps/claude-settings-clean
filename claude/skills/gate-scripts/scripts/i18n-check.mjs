#!/usr/bin/env node
/**
 * i18n sanity check.
 *
 * - Lists translation keys that exist in en.ts but are never referenced in src/.
 * - Lists t('...') call sites whose key isn't defined in en.ts (runtime misses
 *   slip past TS only when callers use `as any` casts — this flags them).
 * - Compares en.ts against he.ts for {{placeholder}} drift and untranslated
 *   values.
 *
 * On he.ts: KEY PARITY IS ALREADY ENFORCED BY THE COMPILER — `he.ts` declares
 * `const he: Translations`, so a missing key is a type error and an extra key is
 * an excess-property error. This script deliberately does NOT re-do that. What
 * the type system cannot see is the *inside* of the strings: if en says
 * '{{count}} entries' and he drops the {{count}}, both compile and the number
 * silently never renders. That is the check below, and it is a hard failure.
 *
 * SURFACES vs. THE TABLES. One set of tables (default `src/i18n/`) can serve
 * several surfaces — say a native app in `src/` and a web app in `web/src/`
 * importing the same tables through an alias. The scan root and the table
 * location are then two different things, and conflating them breaks the gate
 * the moment a second consumer appears:
 *   - a run on the second surface looked for `<root>/i18n` and crashed, so the
 *     surface was never wired into the verify chain at all;
 *   - orphan detection is only meaningful across ALL consumers — scanning one
 *     surface alone reports every key only the other one renders as unused.
 * Hence: the tables are located once (below), the PRIMARY run credits usage
 * from every consumer surface, and an AUXILIARY run (a scan root that does not
 * own the tables) reports only what is local to it — the missing keys.
 *
 * Config (gate-config.json, section `i18n`; see loadGateConfig below):
 *   tablesDir      where en.ts lives when the scan root has no i18n/ of its own
 *                  (default: src/i18n)
 *   consumerRoots  the OTHER trees that call t() against these tables, credited
 *                  for orphan detection on the primary run (default: none)
 *
 * Usage: node scripts/i18n-check.mjs [scan-root]   (scan-root defaults to src)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/* ── per-project config ──────────────────────────────────────────────────────
   Project specifics (where the tables live, which trees consume them) live in
   JSON, never in this script. A repo-committed `.claude/gate-config.json` wins
   (a repo that carries its own bar); else `$GATE_STATE_DIR/gate-config.json`
   (the external runner's per-repo state, so nothing is written into the
   project). Each gate reads only its own section. An unknown or mistyped key is
   an ERROR: a typo would otherwise switch a check off without a word. */
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

const { cfg: CONFIG } = loadGateConfig('i18n', {
  tablesDir: (v) => typeof v === 'string' && v.length > 0,
  consumerRoots: isStrList,
});

const ROOT = process.cwd();
// Directory to scan — argv[2] so the perimeter can grow (a second surface too).
const SRC = join(ROOT, process.argv[2] || 'src');

/** Where the tables actually are: inside the scan root, or the configured home. */
const I18N_DIR = existsSync(join(SRC, 'i18n'))
  ? join(SRC, 'i18n')
  : join(ROOT, CONFIG.tablesDir ?? join('src', 'i18n'));
const EN_PATH = join(I18N_DIR, 'en.ts');
if (!existsSync(EN_PATH)) {
  console.error(`✖ i18n check: no en.ts at ${relative(ROOT, EN_PATH)} — set i18n.tablesDir in gate-config.json, or pass the scan root that owns the tables.`);
  process.exit(1);
}

/** The run that reports on the TABLES (orphans, locale drift): the one whose
 *  scan root owns them, or — when they live outside every scan root
 *  (i18n.tablesDir) — the default run with no scan-root argument. Otherwise
 *  nothing would ever check them. Path-segment aware: `src2/i18n` is not
 *  inside `src`. */
const IS_PRIMARY = I18N_DIR.startsWith(SRC + sep) || !process.argv[2];

/** Every tree that calls `t()` against these tables. Used for orphan credit on
 *  the primary run, so a key that only another surface renders is not "unused". */
const CONSUMER_ROOTS = [SRC, ...(IS_PRIMARY ? (CONFIG.consumerRoots ?? []).map((d) => join(ROOT, d)) : [])]
  .filter((d) => existsSync(d));

/** Every locale file except en.ts (the source of truth) is validated below —
 *  drop a new ar.ts/ru.ts into src/i18n and it is checked with NO change here. */
const LOCALE_PATHS = readdirSync(I18N_DIR)
  .filter((f) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.ts$/.test(f) && f !== 'en.ts' && f !== 'index.ts')
  .sort()
  .map((f) => join(I18N_DIR, f));

/** Plural variants (`key_one` … `key_many`) are resolved at RUNTIME by
 *  translate() from the base key, so they never appear as a literal t('...')
 *  call and must not be reported as orphans. Full CLDR suffix set — locale
 *  files may carry variants en.ts does not declare. */
const PLURAL_VARIANT_RE = /_(zero|one|two|few|many)$/;

function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      if (name === 'i18n') {
        // Locale files would self-credit every key; index.ts is real CONSUMER
        // code (formatDuration renders via units.duration* keys) — scan it.
        const idx = join(p, 'index.ts');
        try { if (statSync(idx).isFile()) out.push(idx); } catch { /* absent */ }
        continue;
      }
      out.push(...collectFiles(p));
    } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function extractDefinedKeys(src) {
  // Matches:   'some.key': '...',   (single-quoted key, any indentation)
  const re = /^\s*'([a-zA-Z0-9_.]+)'\s*:/gm;
  const keys = new Set();
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

/**
 * key → raw string value. Values in these files are always a single line:
 *   'some.key': 'the value',
 * A value spanning lines would simply not match and is reported as unparsed
 * rather than silently skipped.
 */
function extractEntries(src) {
  const re = /^\s*'([a-zA-Z0-9_.]+)'\s*:\s*(['"])([\s\S]*?)\2\s*,?\s*$/gm;
  const map = new Map();
  let m;
  while ((m = re.exec(src)) !== null) map.set(m[1], m[3]);
  return map;
}

/** The set of {{placeholder}} names inside a translation value. */
function placeholders(value) {
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const out = new Set();
  let m;
  while ((m = re.exec(value)) !== null) out.add(m[1]);
  return out;
}

/**
 * Would a human actually translate this string? An en/he value being identical
 * only means something when the string has translatable prose in it.
 *
 * The whole point of this check is that it stays readable — a list padded with
 * brand names and format masks is a list nobody reads, and then a real
 * untranslated sentence hides in it. Every exclusion below corresponds to a
 * real string in this repo that is CORRECTLY identical in both locales.
 */
function isTranslatable(value) {
  const v = value.trim();
  if (v.length <= 2) return false;
  // Pure composition strings: '{{sender}}: {{body}}', '{{current}} / {{total}}',
  // '+{{count}}'. Strip the placeholders and see if any real word survives.
  const withoutVars = v.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, '');
  if (!/[A-Za-z]{3,}/.test(withoutVars)) return false;
  // Acronyms, brand and format masks: 'CSV', 'PDF', 'GPS', a product name,
  // 'YYYY-MM-DD', 'HH:MM'. No lowercase letter anywhere = not prose.
  if (!/[a-z]/.test(withoutVars)) return false;
  // Sample email addresses ('you@company.com') stay Latin.
  if (v.includes('@')) return false;
  // Filename templates ('app-timesheet-{{date}}') must stay ASCII-safe.
  if (!/\s/.test(withoutVars) && /^[a-z0-9._-]+$/.test(withoutVars)) return false;
  return true;
}

function extractUsedKeys(src) {
  // Matches literal   t('key')   or   t("key")
  const literal = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;
  // Matches template-literal prefix   t(`prefix.${...}`   — we capture "prefix." to whitelist those groups
  const tmpl = /\bt\(\s*`([a-zA-Z0-9_.]+)\$\{/g;

  const literalKeys = new Set();
  const templatePrefixes = new Set();
  let m;
  while ((m = literal.exec(src)) !== null) literalKeys.add(m[1]);
  while ((m = tmpl.exec(src)) !== null) templatePrefixes.add(m[1]);
  return { literalKeys, templatePrefixes };
}

const enSrc = readFileSync(EN_PATH, 'utf8');
const defined = extractDefinedKeys(enSrc);

// Also look for ROLE_KEYS-style string arrays of i18n keys: `'contacts.landOwner',`
// Any bare string literal that matches a defined key counts as used.
const bareKeyRe = /['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g;

/** Every t() key and template prefix used anywhere under `root`. */
function collectUsage(root) {
  const literals = new Set();
  const prefixes = new Set();
  for (const f of collectFiles(root)) {
    const src = readFileSync(f, 'utf8');
    const { literalKeys, templatePrefixes } = extractUsedKeys(src);
    for (const k of literalKeys) literals.add(k);
    for (const p of templatePrefixes) prefixes.add(p);

    bareKeyRe.lastIndex = 0;
    let m;
    while ((m = bareKeyRe.exec(src)) !== null) {
      if (defined.has(m[1])) literals.add(m[1]);
    }
  }
  return { literals, prefixes };
}

// MISSING is about THIS surface: a key it calls that no table defines.
const { literals: usedLiterals, prefixes: usedPrefixes } = collectUsage(SRC);
// ORPHAN is about the tables, so it is judged against EVERY consumer surface —
// a key only the web renders is used, not dead.
const allUsed = { literals: new Set(usedLiterals), prefixes: new Set(usedPrefixes) };
for (const root of CONSUMER_ROOTS) {
  if (root === SRC) continue;
  const extra = collectUsage(root);
  for (const k of extra.literals) allUsed.literals.add(k);
  for (const p of extra.prefixes) allUsed.prefixes.add(p);
}

// Orphans: defined but not used via literal and not matched by any template prefix
const orphans = [];
for (const k of IS_PRIMARY ? defined : []) {
  if (allUsed.literals.has(k)) continue;
  // A template prefix may span MULTIPLE dot segments (t(`expenses.category.${c}`),
  // t(`timeForm.entryType.${mode}`)) — match by startsWith, not first segment.
  if ([...allUsed.prefixes].some((p) => k.startsWith(p))) continue;
  // `foo_one` is reached via t('foo', { count }) — credit the base key's usage.
  if (PLURAL_VARIANT_RE.test(k) && allUsed.literals.has(k.replace(PLURAL_VARIANT_RE, ''))) continue;
  orphans.push(k);
}

// Missing: used literals that aren't defined (should be impossible with strict TS,
// but `as any` casts let bugs slip)
const missing = [...usedLiterals].filter((k) => !defined.has(k));

const formatList = (arr) => arr.sort().map((k) => `  - ${k}`).join('\n');

let exitCode = 0;
const scanLabel = relative(ROOT, SRC) || '.';
console.log(`i18n check [${scanLabel}${IS_PRIMARY ? '' : ' · surface'}] — ${defined.size} keys defined in ${relative(ROOT, EN_PATH)}, ${usedLiterals.size} literals used, ${usedPrefixes.size} template prefixes`);
console.log();

if (missing.length > 0) {
  exitCode = 1;
  console.log(`❌ ${missing.length} MISSING key(s) — used in code, not defined in en.ts:`);
  console.log(formatList(missing));
  console.log();
}

if (orphans.length > 0) {
  console.log(`⚠  ${orphans.length} ORPHAN key(s) — defined in en.ts, never referenced:`);
  console.log(formatList(orphans));
  console.log();
  console.log('Orphans don\'t break anything but bloat locale files. Review before deleting; dynamic lookups via t(`prefix.${var}`) are whitelisted by prefix.');
}

/* ── locale-file parity: placeholders and untranslated values ──────────────
   Key parity is the compiler's job (every locale file is typed `Translations`).
   These are the two failure modes it cannot see. Runs for EVERY locale file in
   src/i18n except en.ts.

   PRIMARY RUN ONLY. This section reads the tables, not the scan root, so an
   auxiliary surface run would print the identical report a second time inside
   one `npm run verify` — noise that is how a gate stops being read. */

const enEntries = IS_PRIMARY ? extractEntries(enSrc) : new Map();

// An entry the value-parser can't read (e.g. a trailing comment on the line)
// would silently EVADE the placeholder-drift check below — the key-parser is
// laxer than the value-parser, so compare their counts and fail loudly.
if (IS_PRIMARY && enEntries.size !== defined.size) {
  exitCode = 1;
  const unparsed = [...defined].filter((k) => !enEntries.has(k));
  console.log(`❌ ${unparsed.length} entr(ies) in en.ts evade the value parser — placeholder drift is UNCHECKED for:`);
  console.log(formatList(unparsed));
  console.log();
}

let anyDriftOrUntranslated = false;

for (const localePath of IS_PRIMARY ? LOCALE_PATHS : []) {
  const localeName = relative(I18N_DIR, localePath);
  const locEntries = extractEntries(readFileSync(localePath, 'utf8'));

  const placeholderDrift = [];
  const untranslated = [];

  for (const [key, enValue] of enEntries) {
    const locValue = locEntries.get(key);
    if (locValue === undefined) continue; // compiler's job

    const a = placeholders(enValue);
    const b = placeholders(locValue);
    // A plural variant may legitimately DROP the numeral: Hebrew's singular reads
    // "הודעה אחת", not "1 הודעה". Omitting {{count}} there is idiomatic, not a bug.
    // Inventing a placeholder the caller never passes is still always a bug.
    const missingInLoc = PLURAL_VARIANT_RE.test(key) ? [] : [...a].filter((p) => !b.has(p));
    const extraInLoc = [...b].filter((p) => !a.has(p));
    if (missingInLoc.length || extraInLoc.length) {
      placeholderDrift.push({ key, missingInLoc, extraInLoc });
    }

    if (locValue === enValue && isTranslatable(enValue)) untranslated.push(key);
  }

  console.log(`${localeName} — ${locEntries.size} entries parsed (key parity is enforced by TypeScript, not here)`);
  console.log();

  if (placeholderDrift.length > 0) {
    exitCode = 1;
    anyDriftOrUntranslated = true;
    console.log(`❌ ${placeholderDrift.length} PLACEHOLDER MISMATCH(es) — en.ts and ${localeName} disagree on {{vars}}:`);
    for (const d of placeholderDrift.sort((x, y) => x.key.localeCompare(y.key))) {
      const bits = [];
      if (d.missingInLoc.length) bits.push(`missing in ${localeName}: ${d.missingInLoc.map((p) => `{{${p}}}`).join(', ')}`);
      if (d.extraInLoc.length) bits.push(`extra in ${localeName}: ${d.extraInLoc.map((p) => `{{${p}}}`).join(', ')}`);
      console.log(`  - ${d.key} — ${bits.join('; ')}`);
    }
    console.log();
    console.log('These compile fine and fail at runtime: a dropped {{var}} means the value never renders,');
    console.log('and an invented one renders as literal braces to the user.');
    console.log();
  }

  if (untranslated.length > 0) {
    anyDriftOrUntranslated = true;
    console.log(`⚠  ${untranslated.length} possibly UNTRANSLATED — ${localeName} value is byte-identical to en.ts:`);
    console.log(formatList(untranslated));
    console.log();
    console.log('Some are legitimately identical (product names, units). Review rather than bulk-fix.');
    console.log();
  }
}

if (missing.length === 0 && orphans.length === 0 && !anyDriftOrUntranslated) {
  console.log(IS_PRIMARY
    ? '✓ All good — no missing or orphan keys, no placeholder drift, nothing untranslated.'
    : `✓ Every t() key this surface calls exists in ${relative(ROOT, EN_PATH)} (orphans and locale drift are the primary run's report).`);
}

process.exit(exitCode);
