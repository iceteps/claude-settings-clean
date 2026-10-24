#!/usr/bin/env node
/**
 * font-check — every `fontWeight` must ship with its `fontFamily`.
 *
 * WHY THIS IS A GATE AND NOT A GUIDELINE. React Native does not synthesize
 * weights from one font file: each static Rubik weight is its OWN family name
 * (`theme.ts` says so at the definition). A style that sets `fontWeight: '600'`
 * with no `fontFamily` does not render semibold Rubik — it renders the SYSTEM
 * face, so the text silently leaves the type system. Worse in an override:
 * `[styles.label, { fontWeight: fontWeight.semi }]` keeps the BASE family
 * (`Rubik_400Regular`) and asks for weight 600 the file cannot provide, so the
 * text stays regular while the code reads as if it were bold. Both failures are
 * invisible on iOS in the simulator's default face and obvious on a device.
 *
 * The fix at every site is `fontFamily: fontFamily.<same key>`, or `...text(k)`
 * from `constants/theme.ts` which returns the pair.
 *
 * Baseline is ZERO — the standing rule for this project is that a violation
 * class, once found, gets driven to zero and held there rather than ratcheted.
 * Suppress a genuine exception with `// font-ok(<reason>)` on the line above.
 *
 * Usage: node scripts/font-check.mjs [dir=src]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'src';

/** Files that DEFINE the type system rather than consume it. */
const EXEMPT = [/constants\/theme\.ts$/];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (['.ts', '.tsx'].includes(extname(p))) acc.push(p);
  }
  return acc;
}

/**
 * Object literals containing `fontWeight`, minus the things that only look like
 * one. An import's destructuring braces (`import { fontWeight } from …`) is the
 * big false positive — it names the token without styling anything.
 */
function findStyleObjects(src) {
  const out = [];
  const re = /\{[^{}]*\bfontWeight\b[^{}]*\}/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 200), m.index);
    // An import or a plain re-export names the token, it does not apply it.
    if (/\b(import|export)\s*$/.test(before.trimEnd().slice(-40))) continue;
    if (/^\s*import\b/m.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index + 1))) continue;
    // A type/interface member list declares the shape, it does not set a value.
    if (!/fontWeight\s*:/.test(m[0])) continue;
    out.push({ text: m[0], index: m.index });
  }
  return out;
}

const files = walk(ROOT);
const findings = [];
let suppressed = 0;

for (const file of files) {
  if (EXEMPT.some((re) => re.test(file))) continue;
  const src = readFileSync(file, 'utf8');
  for (const { text, index } of findStyleObjects(src)) {
    if (/\bfontFamily\b/.test(text)) continue;
    const line = src.slice(0, index).split('\n').length;
    const prev = src.split('\n')[line - 2] ?? '';
    if (/font-ok\(/.test(prev)) { suppressed++; continue; }
    findings.push({ file, line, text: text.replace(/\s+/g, ' ').slice(0, 100) });
  }
}

const suffix = suppressed ? ` (${suppressed} suppressed via font-ok)` : '';
console.log(`\nfont check — scanned ${files.length} files in ${ROOT}/${suffix}`);

if (findings.length === 0) {
  console.log('✓ every fontWeight is paired with a fontFamily\n');
  process.exit(0);
}

console.log(`\n✗ ${findings.length} unpaired fontWeight(s) — these render the SYSTEM face, not Rubik:\n`);
for (const f of findings) console.log(`   ${f.file}:${f.line}  ${f.text}`);
console.log(`
Fix: add \`fontFamily: fontFamily.<same key>\`, or spread \`...text('<key>')\`
from constants/theme.ts. RN gives each static weight its own family name, so a
weight without its family is not the weight you asked for.
`);
process.exit(1);
