/**
 * TEMPLATE — src/i18n/index.ts
 *
 * The translate core + locale-aware formatters. Adapt the Locale union and the
 * maps; keep the SHAPE, especially LOCALE_TAGS (see the note on it below).
 */
import en from './en';
import he from './he';

export type Locale = 'en' | 'he';
export type TranslationKey = keyof typeof en;
/** For non-component code (exporters, PDF builders, notification schedulers)
 *  that cannot call a hook — pass this in instead. */
export type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

const translations: Record<Locale, Record<string, string>> = { en, he };

/** Add every RTL locale here — 'ar', 'fa', 'ur' are RTL too. Everything that
 *  asks "is this direction right-to-left" reads this ONE list. */
export const RTL_LOCALES: Locale[] = ['he'];

export function isRTL(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

/**
 * BCP-47 tag per locale. A MAP, never `locale === 'he' ? 'he-IL' : 'en-GB'` —
 * that ternary looks correct with two locales and silently gives every locale
 * you add later UK-English dates and number grouping.
 */
const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  he: 'he-IL',
};

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  // Fall back to the source-of-truth locale, then to the key itself, so a
  // missing string is visible in the UI rather than rendering as "undefined".
  const table = translations[locale] ?? translations.en;
  let out = table[key] ?? translations.en[key] ?? String(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
    }
  }
  return out;
}

/* ── Formatters ───────────────────────────────────────────────────────────
   Intl objects are expensive to construct — building one per row per render
   is a measurable cost in long lists on Hermes. Cache by locale+style. */
const dateFmt = new Map<string, Intl.DateTimeFormat>();
const numberFmt = new Map<string, Intl.NumberFormat>();

function getDateFmt(locale: Locale, opts: Intl.DateTimeFormatOptions, tag: string): Intl.DateTimeFormat {
  const key = `${locale}:${tag}`;
  let f = dateFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE_TAGS[locale], opts);
    dateFmt.set(key, f);
  }
  return f;
}

export function formatDate(date: Date | string, locale: Locale, style: 'short' | 'long' = 'short'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: '2-digit', day: '2-digit' };
  return getDateFmt(locale, opts, style).format(d);
}

export function formatTime(date: Date | string, locale: Locale): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return getDateFmt(locale, { hour: '2-digit', minute: '2-digit' }, 'time').format(d);
}

/** Money in MINOR units (agorot/cents) — keep money integral end to end and
 *  divide only at the display boundary. */
export function formatCurrency(minorUnits: number, locale: Locale, currency = 'ILS'): string {
  const key = `${locale}:${currency}`;
  let f = numberFmt.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE_TAGS[locale], { style: 'currency', currency });
    numberFmt.set(key, f);
  }
  return f.format(minorUnits / 100);
}
