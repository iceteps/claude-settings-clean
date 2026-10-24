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
 * Usage: node scripts/i18n-check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
// Directory to scan — argv[2] so the perimeter can grow (web/ is a surface too).
const SRC = join(ROOT, process.argv[2] || 'src');
const I18N_DIR = join(SRC, 'i18n');
const EN_PATH = join(I18N_DIR, 'en.ts');

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
  // Acronyms, brand and format masks: 'CSV', 'PDF', 'GPS', 'MYAPP',
  // 'YYYY-MM-DD', 'HH:MM'. No lowercase letter anywhere = not prose.
  if (!/[a-z]/.test(withoutVars)) return false;
  // Sample email addresses ('you@company.com') stay Latin.
  if (v.includes('@')) return false;
  // Filename templates ('myapp-timesheet-{{date}}') must stay ASCII-safe.
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

const files = collectFiles(SRC);
const usedLiterals = new Set();
const usedPrefixes = new Set();
const perFileUsages = []; // [{ file, key }]

// Also look for ROLE_KEYS-style string arrays of i18n keys: `'contacts.landOwner',`
// Any bare string literal that matches a defined key counts as used.
const bareKeyRe = /['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const { literalKeys, templatePrefixes } = extractUsedKeys(src);
  for (const k of literalKeys) {
    usedLiterals.add(k);
    perFileUsages.push({ file: f, key: k });
  }
  for (const p of templatePrefixes) usedPrefixes.add(p);

  // Bare key literals (e.g. inside an array) — only count those that match a defined key
  let m;
  while ((m = bareKeyRe.exec(src)) !== null) {
    if (defined.has(m[1])) usedLiterals.add(m[1]);
  }
}

// Orphans: defined but not used via literal and not matched by any template prefix
const orphans = [];
for (const k of defined) {
  if (usedLiterals.has(k)) continue;
  // A template prefix may span MULTIPLE dot segments (t(`expenses.category.${c}`),
  // t(`timeForm.entryType.${mode}`)) — match by startsWith, not first segment.
  if ([...usedPrefixes].some((p) => k.startsWith(p))) continue;
  // `foo_one` is reached via t('foo', { count }) — credit the base key's usage.
  if (PLURAL_VARIANT_RE.test(k) && usedLiterals.has(k.replace(PLURAL_VARIANT_RE, ''))) continue;
  orphans.push(k);
}

// Missing: used literals that aren't defined (should be impossible with strict TS,
// but `as any` casts let bugs slip)
const missing = [...usedLiterals].filter((k) => !defined.has(k));

const formatList = (arr) => arr.sort().map((k) => `  - ${k}`).join('\n');

let exitCode = 0;
console.log(`i18n check — ${defined.size} keys defined in en.ts, ${usedLiterals.size} literals used, ${usedPrefixes.size} template prefixes`);
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
   src/i18n except en.ts. */

const enEntries = extractEntries(enSrc);

// An entry the value-parser can't read (e.g. a trailing comment on the line)
// would silently EVADE the placeholder-drift check below — the key-parser is
// laxer than the value-parser, so compare their counts and fail loudly.
if (enEntries.size !== defined.size) {
  exitCode = 1;
  const unparsed = [...defined].filter((k) => !enEntries.has(k));
  console.log(`❌ ${unparsed.length} entr(ies) in en.ts evade the value parser — placeholder drift is UNCHECKED for:`);
  console.log(formatList(unparsed));
  console.log();
}

let anyDriftOrUntranslated = false;

for (const localePath of LOCALE_PATHS) {
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
  console.log('✓ All good — no missing or orphan keys, no placeholder drift, nothing untranslated.');
}

process.exit(exitCode);
