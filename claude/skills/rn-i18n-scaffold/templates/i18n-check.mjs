#!/usr/bin/env node
/**
 * TEMPLATE — scripts/i18n-check.mjs   ·   wire as: "i18n:check": "node scripts/i18n-check.mjs"
 *
 * Key PARITY between locales is already enforced by the compiler (each locale
 * file is typed against the source-of-truth one). This catches the two things
 * types cannot:
 *   1. a t('key') used in code that exists in NO locale file  → FAILS the build
 *   2. a key defined but never referenced (orphan)            → warning only
 *
 * Exits non-zero only on (1), so it is safe in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'src';
const SOURCE_LOCALE = 'src/i18n/en.ts';
/** Keys reached via t(`prefix.${var}`) can't be found statically — whitelist
 *  their prefixes so dynamic lookups aren't reported as orphans. */
const DYNAMIC_PREFIXES = ['status.', 'role.', 'expenses.category.'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (['.ts', '.tsx'].includes(extname(full))) out.push(full);
  }
  return out;
}

const defined = new Set(
  [...readFileSync(SOURCE_LOCALE, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]),
);

const used = new Set();
for (const file of walk(SRC)) {
  if (file.startsWith('src/i18n/')) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
}

const missing = [...used].filter((k) => !defined.has(k));
const orphans = [...defined].filter(
  (k) => !used.has(k) && !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)),
);

console.log(`i18n check — ${defined.size} keys defined, ${used.size} used`);

if (orphans.length) {
  console.log(`\n⚠  ${orphans.length} ORPHAN key(s) — defined, never referenced:`);
  for (const k of orphans.slice(0, 25)) console.log(`  - ${k}`);
  if (orphans.length > 25) console.log(`  … and ${orphans.length - 25} more`);
  console.log("\nOrphans don't break anything but bloat locale files. Review before deleting;");
  console.log('dynamic lookups are whitelisted by prefix in DYNAMIC_PREFIXES.');
}

if (missing.length) {
  console.error(`\n✖  ${missing.length} MISSING key(s) — used in code, defined nowhere:`);
  for (const k of missing) console.error(`  - ${k}`);
  process.exit(1);
}
