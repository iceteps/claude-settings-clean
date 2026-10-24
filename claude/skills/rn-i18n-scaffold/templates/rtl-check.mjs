#!/usr/bin/env node
/**
 * TEMPLATE — scripts/rtl-check.mjs  ·  wire as: "rtl:check": "node scripts/rtl-check.mjs"
 *
 * Guards the RTL invariants a grep CAN prove. Every rule below is a bug that has
 * really shipped in a production RN app — none of it is hypothetical.
 *
 * It cannot catch the two most expensive defects:
 *   - a Text with NO textAlign (aligns per STRING, so Hebrew- and Latin-named
 *     items land on opposite sides of one list — nothing written down to grep);
 *   - whether a physical value is geometric or directional. That is judgement,
 *     which is why those are warnings.
 *
 * Adjust EXEMPT to your project. The raw-HTML/CSS entries matter: in CSS
 * `text-align` is PHYSICAL and never mirrors, so `rtl ? 'right' : 'left'` is
 * CORRECT there — the exact inverse of the React Native rule.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const SRC = 'src';

/** Files where a rule legitimately does not apply. */
const EXEMPT = [
  // The provider DEFINES textStart/textEnd/inputStart and documents the
  // anti-patterns in prose, so it necessarily contains the banned strings.
  'src/providers/I18nProvider.tsx',
  // Anything emitting raw HTML/CSS (PDF export, email templates, print views):
  // CSS `text-align` is PHYSICAL and never mirrors, so deriving it from `rtl` is
  // CORRECT there. Add your own.
  // 'src/lib/export-pdf.ts',
];

const RULES = [
  {
    id: 'row-reverse',
    level: 'error',
    // Ignore the word inside a comment.
    re: /flexDirection:\s*['"]row-reverse['"]/g,
    msg: "flexDirection: 'row-reverse' — both platforms already mirror 'row', so this flips twice and renders left-to-right. Use useI18n().row.",
  },
  {
    id: 'textalign-ternary',
    level: 'error',
    re: /textAlign:\s*\(?\s*(?:rtl|isRTL|I18nManager\.isRTL)\s*\?/g,
    msg: "textAlign derived from rtl — native ALREADY mirrors an explicit textAlign under RTL (iOS RCTAttributedTextUtils.mm, Android TextAttributeProps.kt), so this double-flips and lands the text on the WRONG side. Use useI18n().textStart / .textEnd.",
  },
  {
    id: 'textalign-literal',
    level: 'error',
    re: /textAlign:\s*['"](?:left|right)['"]/g,
    msg: "bare textAlign: 'left'/'right' — on a <Text> this mirrors on native but NOT on web (RNW passes the literal to physical CSS). Use useI18n().textStart / .textEnd on <Text>, and inputStart on <TextInput> (which does NOT auto-mirror — different mechanism, see I18nProvider).",
  },
  {
    id: 'align-ternary',
    level: 'error',
    re: /(?:justifyContent|alignItems|alignSelf):\s*\(?\s*(?:rtl|isRTL)\s*\?/g,
    msg: "justifyContent/alignItems derived from rtl — the cross axis already mirrors ('flex-start' IS the right edge in RTL), so this double-flips. Write the plain value.",
  },
  {
    id: 'direct-i18nmanager',
    level: 'error',
    re: /I18nManager\.isRTL/g,
    msg: 'component reads I18nManager directly — direction has ONE owner (I18nProvider). Use useI18n().rtl, which stays correct when the locale changes.',
  },
  {
    id: 'position-ternary',
    level: 'error',
    re: /(?:left|right):\s*\(?\s*(?:rtl|isRTL)\s*\?/g,
    msg: "position inset derived from rtl — native REWRITES Edge::Left to Edge::Start under RTL (YogaLayoutableShadowNode::swapStyleLeftAndRight, on by default via RCTI18nUtil), so asking for 'left' in RTL resolves to the RIGHT edge and this double-flips. Write the plain logical `start:` / `end:`, which is never swapped and is correct on web too.",
  },
  {
    id: 'measured-coord-as-left',
    level: 'warn',
    re: /measureInWindow|\bpageX\b/g,
    msg: 'runtime-measured PHYSICAL coordinate. If it is fed back as `left:`, native re-reads it as a logical start offset and the element lands MIRRORED (the classic anchored-dropdown bug — device only, browser looks fine). Convert first: `const start = rtl ? windowWidth - x - width : x`.',
  },
  {
    id: 'physical-edge',
    level: 'warn',
    re: /(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeftWidth|borderRightWidth|borderLeftColor|borderRightColor):/g,
    msg: 'physical edge. NOT simply "does not mirror": native silently rewrites these to their start/end forms under RTL, while web leaves them physical — so one source line behaves differently on the two platforms. Use marginStart/marginEnd, paddingStart/paddingEnd, borderStart*/borderEnd* explicitly. Genuinely GEOMETRIC values (left:0+right:0 stretch pairs, shadowOffset, symmetric radii, full-screen chrome) may stay physical.',
  },
];

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

/** Strip // and /* *\/ comments so prose about a rule doesn't trip it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const errors = [];
const warnings = [];

for (const file of walk(SRC)) {
  const rel = relative('.', file).split('\\').join('/');
  if (EXEMPT.includes(rel)) continue;
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lineOf = (idx) => code.slice(0, idx).split('\n').length;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      const hit = { file: rel, line: lineOf(m.index), rule: rule.id, msg: rule.msg, text: m[0].trim() };
      (rule.level === 'error' ? errors : warnings).push(hit);
    }
  }
}

/**
 * ELEMENT-AWARE CHECK — a plain regex cannot do this one, and it is exactly the
 * bug that shipped: `textAlign: textStart` is a legal, correct value... on a
 * <Text>. On a <TextInput> it hard-LEFT-aligns the field in RTL, because
 * TextInput never sets textAttributes.layoutDirection and so never gets the
 * Left<->Right swap that <Text> gets. Find the opening tag of every <TextInput>
 * and look inside it.
 */
function textInputOpeningTags(src) {
  const spans = [];
  const re = /<TextInput\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    for (let j = m.index + m[0].length; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        spans.push([m.index, j]);
        break;
      }
    }
  }
  return spans;
}

for (const file of walk(SRC)) {
  const rel = relative('.', file).split('\\').join('/');
  if (EXEMPT.includes(rel)) continue;
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const [a, b] of textInputOpeningTags(code)) {
    const seg = code.slice(a, b);
    if (/textAlign:\s*text(Start|End)\b/.test(seg)) {
      errors.push({
        file: rel,
        line: code.slice(0, a).split('\n').length,
        rule: 'textstart-on-textinput',
        text: '<TextInput … textAlign: textStart>',
        msg: '`textStart`/`textEnd` on a <TextInput>. Those are for <Text>, which auto-mirrors; TextInput does NOT (BaseTextInputProps::getEffectiveTextAttributes never sets layoutDirection, so the Left<->Right swap is skipped). This hard-LEFT-aligns the field in RTL under a right-aligned label. Use useI18n().inputStart — or leave textAlign unset for inherently-Latin fields (phone, email, coordinates).',
      });
    }
  }
}

const byRule = (list) => {
  const g = new Map();
  for (const h of list) {
    if (!g.has(h.rule)) g.set(h.rule, []);
    g.get(h.rule).push(h);
  }
  return g;
};

console.log(`rtl check — scanned ${walk(SRC).length} files in ${SRC}/`);

if (warnings.length) {
  const g = byRule(warnings);
  for (const [id, hits] of g) {
    console.log(`\n⚠  ${hits.length} ${id}`);
    console.log(`   ${hits[0].msg}`);
    for (const h of hits.slice(0, 12)) console.log(`   - ${h.file}:${h.line}  ${h.text}`);
    if (hits.length > 12) console.log(`   … and ${hits.length - 12} more`);
  }
  console.log('\nWarnings need a human call (directional vs geometric) — they do not fail the build.');
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
  process.exit(1);
}

console.log('✓ no RTL rule violations');
