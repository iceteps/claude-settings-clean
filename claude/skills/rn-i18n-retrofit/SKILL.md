---
name: rn-i18n-retrofit
description: Add or repair i18n + RTL in an EXISTING React Native / Expo app — audit hardcoded strings and physical style props, migrate incrementally without breaking shipped screens, and fix a half-working setup (RTL mirroring twice, headers refusing to center, direction following the device language, a language switch that does nothing). Use on any app that already has screens. For a brand-new project use rn-i18n-scaffold.
---

# Retrofit i18n + RTL (existing project)

The work is 20% writing code and 80% finding what's already wrong. **Audit first, always** — a
codebase that grew without i18n has hardcoded strings and physical style props in places no one
remembers, and a "quick" RTL switch will visibly break screens that ship today.

If RTL is already half-working and mis-rendering, **load `rn-rtl` first** — it has the diagnosis
table that maps each symptom to its single cause. Do not start editing layout code before you can
name the cause; RTL bugs almost never live where they appear.

## Phase 1 — Audit. Change nothing.

Run these and record counts, not just a feeling. The numbers decide the plan.

```bash
# Hardcoded user-visible strings — the real size of the job
grep -rnE '>[A-Z][a-z]{2,}' src/ --include=*.tsx | grep -v "t(" | wc -l

# Physical edges that will NOT mirror (these are the expensive ones)
grep -rn "marginLeft:\|marginRight:\|paddingLeft:\|paddingRight:\|borderLeftWidth\|borderRightWidth" src/ | wc -l
grep -rnE "^\s+(left|right): " src/ --include=*.tsx | wc -l
# Direction double-flips — the classic self-inflicted RTL bugs. BOTH of these read
# as the fix and ARE the bug. See `rn-rtl` before "correcting" either.
grep -rn "row-reverse" src/ | wc -l
grep -rn "rtl ? 'flex-end'\|rtl ? 'flex-start'" src/ --include=*.tsx | wc -l
grep -rn "textAlign: rtl ?\|textAlign: isRTL ?" src/ --include=*.tsx | wc -l
# Position insets derived from rtl — same double-flip, different property. Native
# rewrites Edge::Left to Edge::Start under RTL; web does not.
grep -rnE "(left|right):\s*\(?\s*(rtl|isRTL)\s*\?" src/ --include=*.tsx | wc -l
# Measured PHYSICAL coordinates. If any is fed back as `left:`, the element lands
# mirrored on device (the anchored-dropdown bug). Inspect each by hand.
grep -rn "measureInWindow\|pageX" src/ --include=*.tsx
# textAlign on TextInput vs Text — they behave OPPOSITELY. Check each hit's element.
grep -rn "textAlign" src/ --include=*.tsx | grep -i "input\|search"

# Directional glyphs that must flip
grep -rn "chevron-back\|chevron-forward\|arrow-back\|arrow-forward" src/ --include=*.tsx | wc -l

# Formatters — a binary ternary here silently breaks every future locale
grep -rn "=== 'he' ?\|=== 'ar' ?" src/i18n/ 2>/dev/null
```

Also check, by reading:
- **Fonts.** Does the current typeface cover the target script? If a custom font is loaded, this is
  a blocker discovered at the worst possible moment otherwise.
- **Third-party UI.** Calendars, charts, carousels and image viewers ship their own direction
  assumptions and their own locale registries. List them now.
- **Non-component code** — exporters, PDF builders, notification schedulers. They can't call a hook
  and will need `t` threaded in as a `TranslateFn` parameter.

Report the counts before proposing a plan. A project with 30 physical props is an afternoon; one
with 300 is a staged migration.

## Phase 2 — Land the infrastructure

Set up the translation files, the provider and the parity check exactly as in `rn-i18n-scaffold`
(its `templates/` are directly reusable). Two retrofit-specific cautions:

- **Introduce the second locale with the key-parity type from the very first commit.** Adding it
  later means reconciling hundreds of keys by hand.
- **Do not flip RTL on yet.** Get strings extracted first. Turning direction on mid-extraction
  means you cannot tell a translation bug from a layout bug.

## Phase 3 — Extract strings, screen by screen

One screen per commit. Never a bulk sweep: a bulk regex over JSX text nodes will eat prop values,
test IDs and code samples, and the diff is too large to review honestly.

Per screen: replace literals with `t('screen.element')`, add the keys to the source locale, let the
compiler tell you what the other locale is missing, then `npm run i18n:check`.

## Phase 4 — Turn on RTL

Follow the setup in `rn-rtl` ("The setup that works"). Then convert what genuinely does not mirror,
in this order — cheapest and safest first:

1. **Delete every `row-reverse`.** Plain `'row'` is correct; the platform mirrors it. This alone
   fixes the "some rows are backwards" class of bug.
2. **Delete every `rtl ? 'flex-end' : 'flex-start'`.** The cross axis already mirrors, so choosing
   the opposite by hand flips twice. Write the plain logical value.
3. **Delete every `textAlign: rtl ? …`.** Native mirrors an explicit `textAlign` already, so this
   flips twice and lands the text on the wrong side. Replace with the platform-aware
   `textStart`/`textEnd` constants from `rn-rtl`, and set them explicitly on titles, section
   labels, list rows and form labels — leaving `textAlign` unset gives per-string bidi alignment,
   which is what makes titles land on different sides in the same list.
4. **Split `<TextInput>` off from `<Text>`.** Inputs do NOT auto-mirror `textAlign` (only
   `<Text>` does), so they need their own `inputStart` value derived from `rtl`. Reusing the
   `<Text>` constant hard-left-aligns every field in the RTL language under a right-aligned
   label — and it passes every grep, because the value is legal and only the element is
   wrong. Fields whose content is inherently Latin (phone, email, URL, codes) are usually
   best left with no `textAlign` at all.
5. **Physical → logical props**: `marginStart`/`marginEnd`, `paddingStart`/`paddingEnd`,
   `start`/`end`, `borderStart*`. **Not for the reason usually given** — native does not ignore
   physical edges, it silently REWRITES them to their start/end forms, while web leaves them
   physical (see `rn-rtl`). So the same line behaves differently per platform, and two specific
   things become bugs: `rtl ? { left: X } : { right: X }` double-flips, and a runtime-MEASURED
   coordinate fed back as `left:` lands the element mirrored (the broken anchored dropdown).
   Judge each one — some are GEOMETRIC and must stay physical: `left: 0` + `right: 0` pairs that
   stretch, shadow offsets, symmetric radii, bottom-sheet top corners, map and media-viewer
   chrome. Converting those is a regression, not a fix.
6. **Directional glyphs** — `rtl ? 'chevron-forward' : 'chevron-back'`. Leave non-directional icons
   (close, add, checkmark, play, expand/collapse) alone.
7. **Gestures** — a swipe keyed to `dx > 0` will contradict its own flipped arrows.
8. **Third-party components** — register locales (calendars print English month names inside an RTL
   UI otherwise) and check horizontal scroll/paging start positions.

## Phase 5 — Verify

Static checks cannot prove RTL. Use the device list in `rn-rtl` — in particular test **both**
language directions on **both** device system languages. Testing only one hides the
`expo-localization` `supportsRTL` trap, which produces two opposite symptoms from one line.

Then produce a walkthrough for the owner: every screen marked correct / worth-a-glance / broken,
with file references. On a retrofit there will always be a tail of judgement calls a static read
cannot settle — mixed-direction strings like `09:00 — 17:00`, phone numbers, codes, numeric columns
— and the owner should be told exactly where to look rather than left to hunt.

## Things that will bite on a retrofit specifically

- **A global stylesheet "fixing" text alignment.** Someone always adds a blanket
  `text-align: right` for RTL web. It beats react-native-web's atomic style classes on specificity
  and silently kills every `textAlign: 'center'` in the app. Remove it and fix the real cause
  (the `dir` prop — see `rn-rtl`).
- **Locale detection that already shipped.** Changing the default locale changes what existing
  users see on next launch. Decide deliberately and say so in the release notes.
- **Persisted user data containing UI strings.** Statuses or categories stored as English display
  text rather than keys have to be migrated, not translated.
