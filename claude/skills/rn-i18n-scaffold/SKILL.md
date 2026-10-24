---
name: rn-i18n-scaffold
description: Scaffold i18n + RTL into a NEW React Native / Expo project from scratch — translation files with compiler-enforced key parity, a locale provider that gets RTL right on native and web, per-locale date/number formatting, a key-parity check script, and the conventions that keep it from rotting. Use when starting a bilingual/multilingual RN app, or when a project has no i18n at all yet. For an app that already has strings or a half-working setup, use rn-i18n-retrofit instead.
---

# Scaffold i18n + RTL (new project)

Build it right once. Retrofitting later costs an order of magnitude more — see `rn-i18n-retrofit`.

Templates live in `templates/` next to this file. Read them, then adapt — do not paste blindly,
the project's paths and lint rules differ.

## Decide these four things first

Ask the user if any is unclear; each one is expensive to change later.

1. **Which locales, and which are RTL.** Hebrew and Arabic are RTL; Farsi and Urdu too. This
   decides whether you need the RTL machinery at all.
2. **The default locale, and how it's detected.** "Follow the device, fall back to X" is the usual
   answer. Be explicit about what an unrecognised device language gets.
3. **Is there an in-app language switcher?** If yes, native RTL needs a bundle reload, which means
   `expo-updates` — decide now, it's a native dependency and changes the build.
4. **The typeface.** It must cover every script you ship (Latin + Hebrew + Arabic + Cyrillic as
   applicable). Check before choosing, not after the design is locked. React Native does not
   synthesize weights: each static weight is its own `fontFamily`, so plan a `fontFamily` token map
   next to your `fontWeight` map.

## Files to create

| File | Purpose |
|---|---|
| `src/i18n/en.ts` | **Source of truth.** Flat dot-notation keys, `{{var}}` interpolation. |
| `src/i18n/he.ts` (etc.) | `import type { Translations } from './en'` → the compiler enforces key parity. This is the single highest-value decision in the whole setup. |
| `src/i18n/index.ts` | `translate()`, `isRTL()`, `RTL_LOCALES`, and the formatters. |
| `src/providers/I18nProvider.tsx` | Locale state, persistence, and direction ownership. |
| `scripts/i18n-check.mjs` | Finds missing and orphaned keys. Wire as `npm run i18n:check`. |
| `scripts/rtl-check.mjs` | Fails the build on the RTL anti-patterns below. Wire as `npm run rtl:check`. |

## The rules that keep it alive

- **Never hardcode a user-visible string.** Every one goes through `t('key')`. This is the rule
  that decays first; put it in the project's `CLAUDE.md`/contributing guide on day one.
- **Keys are flat dot-notation**, `'screen.element'` — greppable, and it makes orphan detection
  trivial. Nested objects make both harder.
- **Parity is compiler-enforced**, not convention. `he.ts` declares `const he: Translations = {...}`
  so a missing key is a type error, not a runtime `undefined` shipped to a user.
- **Formatters take a locale MAP, never a binary ternary.** `locale === 'he' ? 'he-IL' : 'en-GB'`
  looks fine with two locales and silently gives every future locale UK-English dates. Write
  `LOCALE_TAGS: Record<Locale, string>` from the start.
- **Non-component code takes `t` as a parameter.** Exporters, PDF builders and notification
  schedulers can't call a hook — type it as `TranslateFn` and pass it in.
- **Cache `Intl` formatters.** Constructing one per row per render is a real cost in long lists on
  Hermes.
- **Plan for plurals or decide not to.** `{{count}}` with one string per key is fine for
  English/Hebrew short UI strings and genuinely wrong for Russian's three-way plural system. Either
  add plural support to `translate()` now, or write around it with neutral phrasing — deliberately,
  and write down which.

## RTL

`templates/I18nProvider.tsx` implements the correct setup. **Load the `rn-rtl` skill for the
reasoning and the trap list** — especially before touching the `expo-localization` plugin config,
which has a trap that costs a full build cycle to discover. The short version:

- Direction is the platform's job. `useI18n().row` returns `'row'` — **never** `'row-reverse'`.
- Native: `app.json` plugin gets `supportedLocales` only, **not** `supportsRTL`.
- Web: one CSS rule (`html[dir="rtl"] #root { direction: rtl }`) plus `dir` on the root `<View>`.
- Language change: `allowRTL` + `forceRTL`, then reload the bundle.
- `textAlign` on a **`<TextInput>`** uses a DIFFERENT value — `inputStart` — because inputs do
  not auto-mirror the way `<Text>` does. Same-looking code, opposite behaviour; a grep cannot
  tell the elements apart, which is why the template ships an element-aware check for it.
- `textAlign`: use the `textStart`/`textEnd` constants the template exposes. **Never**
  `rtl ? 'right' : 'left'` — native mirrors an explicit textAlign for you, so that flips twice.
  And do not just omit it: unset means per-string bidi, which aligns Hebrew and Latin content
  to opposite sides of the same list.
- Use logical style props (`marginStart`, `paddingEnd`, `start`, `end`) everywhere from day one.
  Retrofitting physical→logical across a grown codebase is the expensive part of `rn-i18n-retrofit`.

## Verify before calling it done

- `npx tsc --noEmit` — proves key parity.
- `npm run i18n:check` — proves no missing keys.
- `npm run rtl:check` — proves nobody mirrored direction twice. Add one aggregate script so all
  of it runs together and people actually use it:
  `"verify": "npm run typecheck && npm run lint && npm run i18n:check && npm run rtl:check"`.
- Add a second locale with ONE key deliberately missing and confirm the build fails. If it doesn't,
  the parity mechanism isn't wired and you have no safety net.
- RTL needs a real device. Run the verification list in `rn-rtl` — static checks cannot prove it.
