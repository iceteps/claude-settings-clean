---
name: rn-rtl
description: Make right-to-left layout actually work in a React Native / Expo app, on native AND web — or diagnose why it renders left-to-right, mirrors twice, refuses to center, or gets stuck after a language switch. Use when adding Hebrew/Arabic support, when RTL "works on web but not the phone" (or the reverse), when direction depends on the device's system language, or before shipping any bilingual RN app.
---

# RTL in React Native / Expo

Direction is the PLATFORM's job, in exactly one place. Your job is to stop fighting it.

The single rule everything else follows from: **never emit `flexDirection: 'row-reverse'`.**
A plain `'row'` is correct in RTL, because both platforms mirror it for you — native via
`I18nManager`, web via inherited CSS `direction: rtl`. Emitting `row-reverse` on top flips a
second time and lands back in left-to-right. Expose `row` from your i18n hook if you like
(it documents intent and gives you one place to change), but have it return `'row'`.

## Diagnose before you touch layout code

RTL bugs almost never live where they appear. Work this list in order and stop at the first hit —
each one produces a DIFFERENT symptom, and fixing the wrong one makes things worse.

| Symptom | Cause | Check |
|---|---|---|
| Some rows mirror, others don't, seemingly at random | Double flip — the platform mirrors AND the code emits `row-reverse` | `grep -rn "row-reverse" src/` |
| `textAlign: 'center'` is ignored app-wide (headers never center) | A global stylesheet forcing `text-align`, beating react-native-web's atomic classes on specificity | Look for injected CSS with `text-align` on `div`/`span` |
| Web: rows mirror, but text hugs the wrong side and every `start`/`end` inset is on the wrong edge | react-native-web's locale context is LTR — it compiles logical props at BUILD time and picks a side at runtime from a React context, NOT from CSS `direction` | `grep -rn "LocaleProvider\|dir=" src/` — is `dir` set on a root View? |
| Native: everything LTR while text still right-aligns | `I18nManager.isRTL` is false; text alignment is just bidi, not layout | Log `I18nManager.isRTL` at startup |
| Rows mirror correctly, but the TEXT inside sits on the wrong side (a dropdown's icon is at the start and its label at the far end) | `textAlign: rtl ? 'right' : 'left'` — native already mirrors an explicit textAlign, so this flips twice | `grep -rn "textAlign: rtl ?" src/` |
| Titles land on the left in some rows and the right in others, with no pattern | No `textAlign` at all → natural/bidi alignment, resolved per STRING: Hebrew content aligns right, Latin content aligns left | Check whether the wrong-side ones contain Latin text or digits |
| An anchored dropdown / popover opens on the OPPOSITE side of the screen from its trigger — on device only, browser is fine | A runtime-measured PHYSICAL coordinate (`measureInWindow`) fed back as `left:`, which native rewrites to `start` | Does the component measure a trigger and assign the result to `left`? |
| Every form FIELD is left-aligned in the RTL language while its own LABEL is right-aligned | `textAlign` that auto-mirrors on `<Text>` was reused on `<TextInput>`, which does not mirror | `grep -rn "textAlign" src/` — is the same constant used on both elements? |
| A paging gallery opens on the wrong photo / counts backwards | One RTL scroll-offset formula applied to "native"; iOS already normalises, Android does not | Does the pager branch iOS, Android and web separately? |
| Native: direction follows the DEVICE language and ignores the in-app language switch | `expo-localization` plugin configured with `supportsRTL` — see below | Read the plugin entry in `app.json` |
| Native: a language switch changes nothing until you force-quit | Nothing reloads the bundle after `forceRTL` | Is `expo-updates` installed AND is `reloadAsync` reached? |

### The native facts that explain all of it

- `I18nManager.forceRTL()` **only writes a preference**. It does not relayout. (iOS:
  `RCTI18nUtil.m` writes `RCTI18nUtil_forceRTL` to `NSUserDefaults` and returns.)
- `I18nManager.isRTL` in JS is a **startup constant**, captured once at module load. It cannot
  change in a running process.
- Fabric bakes the Yoga root direction at **surface init**, not on preference change.
- Therefore **a direction change requires a bundle restart.** There is no way around this without
  abandoning the layout engine (see "The instant-flip trade-off").
- iOS resolves direction as: `isRTLForced` → YES, else `isRTLAllowed && isApplicationPreferredLanguageRTL`.
  Two absolute overrides fall out of that, and they are what make the app's own locale authoritative:
  - `forceRTL(true)` short-circuits **before** the device language is consulted → RTL anywhere.
  - `allowRTL(false)` disables the device-language branch entirely → LTR anywhere.
- `isApplicationPreferredLanguageRTL` resolves against the **app bundle's** localizations, not the
  device's. With no `CFBundleLocalizations` the app is English-only to iOS and returns NO even on a
  Hebrew phone.

### The expo-localization trap (costs a full build cycle to find)

`["expo-localization", { "supportsRTL": true }]` looks like the obvious answer. It is a trap for any
app with an **in-app** language switch.

Its `OnCreate` runs before React loads, on **every launch**, and with `supportsRTL` and no
`forcesRTL` it writes:

```
RCTI18nUtil_allowRTL = true
RCTI18nUtil_forceRTL = isRTLPreferredForCurrentLocale()   // ← the DEVICE language
```

So it silently erases whatever your language switch just wrote. One line, two opposite symptoms:
Hebrew stuck LTR on an English phone, English stuck RTL on a Hebrew phone. The loop-guard on your
reload then correctly refuses to retry, and it looks permanently broken.

**Use `supportedLocales` only.** It writes `CFBundleLocalizations` (so a device in an RTL language
is correct on the first frame, since `allowRTL` defaults to YES) and writes no preference of its own,
leaving your app the sole authority:

```json
["expo-localization", { "supportedLocales": { "ios": ["en", "he"] } }]
```

Use `forcesRTL: true` only if the app is RTL for everyone, always — it mirrors the UI for your
LTR users too.

## The setup that works

1. **Native declaration** — `supportedLocales` in the plugin props (above). No `supportsRTL`.
2. **Web** — ONE rule, on the root only. `direction` inherits and the browser does the rest: flex
   rows reverse natively AND text with the initial `text-align: start` resolves correctly.
   ```css
   html[dir="rtl"] #root { direction: rtl; }
   ```
   Never add a blanket `text-align` — it beats react-native-web's style classes and kills every
   `textAlign: 'center'` in the app.
3. **Web logical props** — put `dir={rtl ? 'rtl' : 'ltr'}` on your root `<View>`. This installs
   react-native-web's `LocaleProvider`, which is what makes `marginStart` / `paddingEnd` /
   `start` / `end` and RNW's own base `textAlign: 'start'` resolve to the correct side. CSS
   `direction` does NOT do this — RNW resolves them from its own React context, which defaults LTR.
4. **Native, on locale change** — `allowRTL(v)` + `forceRTL(v)`, then reload the bundle
   (`expo-updates` `reloadAsync()`).
5. **Native, at startup** — if `I18nManager.isRTL !== isRTL(locale)`, flip and reload ONCE.
   **Guard it against boot loops**, keyed on the target direction so a genuinely different target
   still gets its own attempt:
   ```ts
   const target = wantRTL ? 'rtl' : 'ltr';
   if ((await AsyncStorage.getItem(KEY)) === target) return;  // already tried this one
   await AsyncStorage.setItem(KEY, target);
   I18nManager.allowRTL(wantRTL); I18nManager.forceRTL(wantRTL);
   try { await require('expo-updates').reloadAsync(); }
   catch { /* no updates runtime — tell the user to restart; the pref persists */ }
   ```
   Clear the key when `isRTL === wantRTL`, and on an explicit user language change.
6. **If the reload can't run** (dev client, updates disabled), SAY SO. The preference is written and
   will apply on the next launch — an unchanged screen with no message reads as a broken feature.

## What genuinely does NOT auto-mirror

Everything else is handled for you. These are not:

- **Physical edges — NOT the way almost every RTL guide says. Read the section below before
  touching one.** On native they DO mirror; on web they do not. Same source line, two behaviours.
- **`textAlign` — also not the way you expect, and `<Text>` and `<TextInput>` differ from each
  other.** Two sections below.
- **Directional glyphs** — chevrons and arrows never mirror themselves:
  `name={rtl ? 'chevron-forward' : 'chevron-back'}`. Do NOT flip non-directional icons (close, add,
  checkmark, play, expand/collapse).
  Some glyphs have **no mirrored twin in the icon set at all** — in Ionicons, `log-out-outline`,
  `log-in-outline`, `exit-outline` and `enter-outline` all draw the arrow pointing right, so there
  is no name to swap to. Those need a `transform: [{ scaleX: -1 }]` style, which means your
  `Button`/`IconButton` wrapper has to accept an icon style. Check that before promising the fix.
- **An icon placed INSIDE a text run is positioned by bidi, not by layout.** This one is invisible
  until it bites. Icon-font glyphs are Private Use Area codepoints with bidi class **L**, so
  `<Text><Icon/>{'  '}{name}</Text>` renders the icon *leading* next to a Latin name and *trailing*
  next to a Hebrew one — the same line, opposite placement, decided by whose name it is. It is the
  per-string bidi bug wearing a different hat. Make the icon a flex **sibling** instead:
  `<View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>` with the icon and a plain
  `<Text>` inside, so flex order — which both platforms mirror — decides it.
- **Gestures** — a swipe handler keyed to `dx > 0` contradicts its own flipped arrows in RTL.
- **Third-party components** — they ship their own assumptions. Calendars in particular need an
  explicit locale registered or they render English month names inside your RTL UI. Watch for
  libraries that mirror off `I18nManager.isRTL` directly: that is a no-op on web, so their internal
  arrows stay unflipped there. Take ownership via whatever render override they expose
  (`renderArrow` and friends) rather than hoping.

## Physical edges: native rewrites them, web doesn't

The near-universal advice is "`left`/`right`/`marginLeft` don't mirror, use the logical forms."
On **web** that is true. On **native it is false**, and believing it produces bugs you cannot find
by reading the component.

`YogaLayoutableShadowNode::swapStyleLeftAndRight()`
(`ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp`) rewrites
`Edge::Left → Edge::Start` and `Edge::Right → Edge::End` for **position, padding, margin and
border on every node in the tree** whenever `swapLeftAndRightInRTL && layoutDirection ==
RightToLeft`. And that flag is **on by default** — `RCTI18nUtil.m` calls
`[sharedInstance swapLeftAndRightInRTL:true]` the first time the singleton is created, and
`RCTFabricSurface.mm` feeds it into the layout context. Android does the same via `I18nUtil`.

So under RTL on a phone, **`left: 20` means "20 from the RIGHT edge."** react-native-web does no
such rewrite (its preprocessor maps only `start`/`end`), so the same line stays physically left in
a browser. That asymmetry is why this class of bug reads as "RTL works in some places and not
others" — correct in the browser, wrong on device.

Three consequences, in order of how much time they cost:

1. **`rtl ? { left: X } : { right: X }` is a double flip.** Native rewrites the `left` you asked
   for into `start`, so in RTL it resolves to the right edge — the mirror of what you wanted.
   Write the plain logical value: `{ start: X }` or `{ end: X }`. Those are never swapped and are
   correct on both platforms. (Exactly the `row-reverse` mistake, in a different property.)

2. **A runtime-MEASURED coordinate must never be fed back as `left:`.** `measureInWindow`,
   `onLayout`'s `pageX`, `getBoundingClientRect` — all return **physical** window coordinates.
   Assign one to `left:` and native re-reads it as a logical start offset, so your anchored
   element lands mirrored across the screen. This is the classic broken **anchored dropdown /
   popover / tooltip**: it opens on the opposite side from the trigger, on device only, and looks
   fine for full-width triggers because a mirrored symmetric box is indistinguishable. Convert
   explicitly before applying:
   ```ts
   // physical x -> logical start inset
   const start = rtl ? windowWidth - x - width : x;
   ```

3. **Genuinely GEOMETRIC values must stay physical** — a `left: 0` + `right: 0` stretch pair,
   `shadowOffset`, symmetric radii, full-screen map/media chrome. Converting those is a
   regression, not a fix. When a corner radius pairs with a pinned corner, convert the position
   and the radius TOGETHER or the rounded corner detaches from the corner it sits in.

Scroll offsets have the same platform split, and it bites paging galleries:
**iOS normalises RTL scroll offsets in both directions** (`RCTScrollViewComponentView.mm` flips a
JS-supplied offset going in and flips the reported `contentOffset.x` coming out), so on iOS the
API contract is already logical — `page i` is `pageW * i`, no adjustment. **Android** reports raw
`getScrollX()`, so logical page 0 sits at max. **Web** forwards the browser's `scrollLeft`, which
runs `0…-max` in an RTL container. One formula for "native" is wrong on one of the two platforms;
branch all three, or you reverse the gallery on whichever one you didn't test.

## `textAlign` — native mirrors it, web does not (the costliest trap after `supportsRTL`)

`textAlign: rtl ? 'right' : 'left'` looks obviously correct and is a **double flip on device**.
It is the single most common self-inflicted RTL bug after `row-reverse`, and it is worse because
the code reads as the fix.

**Native already mirrors an explicit `textAlign`** when the layout direction is RTL — you ask for
`'left'` and you get right. Verified in React Native source, all three text paths:

| Platform | File | Behaviour |
|---|---|---|
| iOS (Fabric) | `RCTAttributedTextUtils.mm` | `if layoutDirection == RightToLeft` → swaps `Left`↔`Right` |
| iOS (Paper) | `RCTTextAttributes.mm` | same swap |
| Android | `TextAttributeProps.kt` | `"left" -> if (isRTL) Gravity.RIGHT else Gravity.LEFT` |

So on native, write the **plain LTR-physical value** and let the platform mirror it — exactly the
`row` rule again:

- align to the reading **start** → `textAlign: 'left'`
- align to the reading **end** → `textAlign: 'right'`

**Web is the opposite.** react-native-web bidi-flips only the values `'start'` and `'end'`
(`StyleSheet/compiler`, `PROPERTIES_VALUE`); a literal `'left'`/`'right'` is passed straight
through to CSS, where it is physical and never mirrors.

There is therefore **no single literal that is correct everywhere**. Expose one platform-aware
constant next to `row` and use it everywhere:

```ts
// In the i18n provider, alongside `row`. NOT derived from `rtl` — that flips twice on native.
const textStart = (Platform.OS === 'web' ? 'start' : 'left') as 'left';
const textEnd   = (Platform.OS === 'web' ? 'end'   : 'right') as 'right';
```

### `<TextInput>` does NOT auto-mirror — the opposite of `<Text>`

Everything above is about `<Text>`. **`<TextInput>` behaves the other way, on both native
platforms**, and the same constant used on both is wrong on one of them.

The Left↔Right swap is gated on `textAttributes.layoutDirection`.
`ParagraphShadowNode.cpp` **sets** that for `<Text>` (from the Yoga direction).
`BaseTextInputProps::getEffectiveTextAttributes`
(`ReactCommon/react/renderer/components/textinput/BaseTextInputProps.cpp`) **never sets it**, so it
defaults to `LeftToRight` and the swap is skipped — `'left'` stays physically left. Android is the
same story: `AndroidTextInputShadowNode` doesn't set it either, so `ReactTextInputManager` resolves
`'left'` to an absolute `Gravity.LEFT`.

Net: put `textStart` on your inputs and **every form field hard-left-aligns in the RTL language**,
while its own label sits correctly on the right directly above it. It looks exactly like the bug
you were trying to fix. Expose a second value, and note it IS derived from `rtl` — unlike
`textStart`, which must never be:

```ts
const inputStart = (Platform.OS === 'web' ? 'start' : rtl ? 'right' : 'left') as 'left';
```

Use `textStart`/`textEnd` on `<Text>`, `inputStart` on `<TextInput>`. A grep cannot tell the two
elements apart, so this is worth a comment at each definition.

One judgement call on top: fields whose content is **inherently Latin** — phone, email, URL, any
numeric or code field — often read better left on natural alignment, since forcing them to the
Hebrew start puts the caret at the wrong end of an obviously left-to-right string.

### Omitting `textAlign` is not the same as `textStart`

An unset `textAlign` is `'auto'` → **natural/bidi alignment, resolved per STRING** from its first
strong character. That is correct for user-authored prose (a chat message, a note) and wrong for UI
chrome, because it makes alignment depend on the *content*: in one Hebrew list a site named
`מגדל כץ` aligns right while `Katz Tower` aligns left, on the same screen, in the same component.

That is the real cause of *"some titles are on the left, others on the right"* — and it is invisible
to every grep, because there is nothing there to find. Set `textStart` explicitly on titles,
section labels, list rows, form labels and empty states; leave prose on natural.

**Two caveats before you go reverting things:**

- **On WEB, unset is not natural.** react-native-web's base `<Text>` style is already
  `textAlign: 'start'` (`dist/exports/Text/index.js`), and `textStart` *is* `'start'` there — so on
  web, setting it and omitting it are the same thing. Every decision in this section is a
  **native-only** behaviour change. Verify on a device; a browser check will show no difference and
  will quietly mislead you.
- **The iOS "unset resolves per string" claim is the one thing you cannot cite from RN.** What is
  provable from `node_modules` is only the negative: RN applies no alignment attribute at all, so
  the paragraph keeps `NSTextAlignmentNatural`. TextKit resolving that from the first strong
  character is standard Apple behaviour, not React Native code. It is almost certainly right, and
  a lot of "leave this natural" decisions rest on it — so if a specific case matters, test it on
  device rather than reasoning about it.

**Keeping a line beside its icon.** If you remove a forced alignment and the text no longer hugs
its leading icon, fix it with **box layout, not text alignment**: `flexShrink: 1` instead of
`flex: 1`, so the box sizes to content while the string keeps its own direction. On web add
`minWidth: 0` alongside — RNW's `<Text>` has no `min-width` reset (its `<View>` does), and CSS's
automatic minimum size would otherwise stop the shrink and let a long string overflow past the icon.

**Typing.** RN's `TextStyle['textAlign']` union is `'auto' | 'left' | 'right' | 'center' |
'justify'` — no `'start'`. So the web branch needs a cast (`as 'left'`), and the `Platform` check
is what guarantees `'start'` never actually reaches native, where it would parse as `Natural`.

## Double-flip smell test

`rtl ? 'flex-end' : 'flex-start'` is almost always a bug. The cross axis already mirrors, so
hand-picking the opposite value flips twice. Write the plain logical value that expresses the intent.

## The instant-flip trade-off

Someone will ask why the language switch needs a reload at all. Answer honestly: avoiding it means
abandoning the layout engine — emitting `row-reverse` yourself and hand-mirroring everything Yoga
does for free. Count the surface before proposing it (`grep -c "flexDirection: 'row'"`, plus every
logical prop and every `flex-start`/`flex-end`); in a mature app it is hundreds of sites, and it
regresses the moment anyone writes a plain `'row'` again. A one-second reload on a setting most
users touch once is the better trade.

## Lock it in with a checker

Every rule above is greppable, and all of them regress the moment someone writes a plain `'row'`
again or "helpfully" adds `rtl ? 'right' : 'left'`. `rn-i18n-scaffold/templates/rtl-check.mjs` is a
ready checker: it ERRORS on `row-reverse`, `textAlign` derived from `rtl`, bare `textAlign`
literals, `rtl`-derived `justifyContent`/`alignItems`, and direct `I18nManager.isRTL` reads, and
WARNS on physical edges (which need a human directional-vs-geometric call). It strips comments
before matching, so documenting a rule doesn't trip it.

Two things it CANNOT catch, so do not treat a green run as proof:
- a `Text` with **no** `textAlign` — the per-string bidi bug has nothing written down to find;
- whether a physical value is geometric or directional. That is judgement, hence a warning.

Wire it beside your other gates: `"verify": "npm run typecheck && npm run lint && npm run
i18n:check && npm run rtl:check"`.

## Verify

Static checks cannot prove RTL. Test on a real device, in this order — each catches a different
one of the traps above:

1. Fresh install, device in the RTL language → **first frame** is mirrored (no reload).
2. Fresh install, device in an LTR language → app starts LTR, correct.
3. Switch the app to the RTL language on the LTR device → reloads, comes up mirrored.
4. Switch back to the LTR language on an RTL-language device → reloads, comes up LTR.
   (3 and 4 are the two halves of the `supportsRTL` trap. Testing only one hides it.)
5. Headers centered, back arrow on the reading-direction start, chevrons pointing the right way.
6. A wrapping paragraph in the RTL language hugs the correct edge (this is the web logical-prop
   check — step 3 of the setup).
