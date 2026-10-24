/**
 * TEMPLATE — src/providers/I18nProvider.tsx
 *
 * Owns the locale AND the app's layout direction. Load the `rn-rtl` skill for
 * why each piece is shaped this way; the comments here state the rule, not the
 * full reasoning.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { I18nManager, Platform, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { formatCurrency, formatDate, formatTime, isRTL, translate, type Locale, type TranslationKey } from '@/i18n';

const LOCALE_KEY = 'app_locale';
/** Records the direction we last reloaded FOR, so a flip that doesn't stick
 *  can't loop — while a genuinely different target still gets its own attempt. */
const RTL_RELOAD_KEY = 'app_rtl_reload_attempt';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  rtl: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  fDate: (date: Date | string, style?: 'short' | 'long') => string;
  fTime: (date: Date | string) => string;
  fCurrency: (minorUnits: number) => string;
  /** ALWAYS 'row'. Both platforms mirror it in RTL; emitting 'row-reverse'
   *  flips a second time and lands back in left-to-right. Exposed so intent is
   *  explicit and one place stays in charge. */
  row: 'row' | 'row-reverse';
  /**
   * `textAlign` following the reading START (right in RTL). Use INSTEAD of
   * `rtl ? 'right' : 'left'`, which double-flips: native already mirrors an
   * explicit textAlign under RTL (iOS RCTAttributedTextUtils.mm / Android
   * TextAttributeProps.kt), so asking for 'right' in Hebrew renders LEFT.
   * Web is the reverse — RNW only bidi-flips 'start'/'end'. Hence the split.
   *
   * Omitting textAlign is NOT equivalent: that is per-STRING bidi alignment, so
   * Hebrew content aligns right and Latin content left in the same list. Set
   * this on titles/labels/rows; leave user prose on natural.
   */
  textStart: 'left' | 'right';
  /** `textAlign` following the reading END. See `textStart`. */
  textEnd: 'left' | 'right';
  /**
   * `textAlign` for a <TextInput>, which — unlike <Text> — does NOT auto-mirror,
   * so this one IS derived from `rtl`. The swap is gated on
   * textAttributes.layoutDirection: ParagraphShadowNode sets it for <Text>,
   * BaseTextInputProps::getEffectiveTextAttributes never does. Using textStart
   * on an input hard-LEFT-aligns every field in RTL, under a right-aligned
   * label — it looks exactly like the bug you were fixing.
   */
  inputStart: 'left' | 'right';
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectLocale(): Locale {
  try {
    const lang = Localization.getLocales()?.[0]?.languageCode;
    if (lang === 'he') return 'he';
  } catch { /* ignore */ }
  return 'en';
}

/**
 * WEB direction. ONE rule, on the root only: `direction` inherits and the
 * browser does the rest — flex rows reverse natively AND text with the initial
 * `text-align: start` resolves correctly.
 *
 * Do NOT add a blanket `text-align` to div/span: it beats react-native-web's
 * atomic style classes on specificity and silently kills every
 * `textAlign: 'center'` in the app.
 */
function applyWebRTL(shouldBeRTL: boolean) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const STYLE_ID = 'app-rtl';
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  document.documentElement.dir = shouldBeRTL ? 'rtl' : 'ltr';
  if (!shouldBeRTL) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = `html[dir="rtl"] #root { direction: rtl; }`;
}

function applyRTL(locale: Locale) {
  const shouldBeRTL = isRTL(locale);
  if (Platform.OS !== 'web') {
    // Two absolute overrides, and they are what make the APP's locale
    // authoritative regardless of the device's system language:
    //   forceRTL(true)   short-circuits isRTL before the device language is read
    //   allowRTL(false)  disables the device-language branch entirely
    I18nManager.allowRTL(shouldBeRTL);
    I18nManager.forceRTL(shouldBeRTL);
  }
  applyWebRTL(shouldBeRTL);
}

/**
 * Native only: make the RUNNING app's direction match the locale.
 *
 * forceRTL merely writes a preference — iOS bakes the layout direction at
 * surface creation and JS captures isRTL as a startup constant, so a mismatch
 * cannot be repaired in place. The bundle has to restart.
 *
 * Reloads at most once PER TARGET DIRECTION: a flip that doesn't take effect
 * must never become a boot loop.
 */
async function reconcileNativeDirection(wantRTL: boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  if (I18nManager.isRTL === wantRTL) {
    try { await AsyncStorage.removeItem(RTL_RELOAD_KEY); } catch { /* non-fatal */ }
    return;
  }
  const target = wantRTL ? 'rtl' : 'ltr';
  try {
    if ((await AsyncStorage.getItem(RTL_RELOAD_KEY)) === target) return;
    await AsyncStorage.setItem(RTL_RELOAD_KEY, target);
  } catch {
    return; // can't guard against a loop → don't risk one
  }
  I18nManager.allowRTL(wantRTL);
  I18nManager.forceRTL(wantRTL);
  try {
    const Updates = require('expo-updates');
    await Updates.reloadAsync();
  } catch {
    // No updates runtime — the preference persists, so the next launch is
    // correct. TELL THE USER to restart; an unchanged screen reads as broken.
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(LOCALE_KEY).then(async (saved) => {
      const loc = (saved as Locale) || detectLocale();
      setLocaleState(loc);
      applyRTL(loc);
      await reconcileNativeDirection(isRTL(loc));
      setReady(true);
    });
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    setLocaleState(next);
    applyRTL(next);
    await AsyncStorage.setItem(LOCALE_KEY, next);
    // A deliberate switch always earns a fresh reload attempt.
    try { await AsyncStorage.removeItem(RTL_RELOAD_KEY); } catch { /* non-fatal */ }
    if (Platform.OS === 'web') {
      window.location.reload();
    } else {
      try {
        const Updates = require('expo-updates');
        await Updates.reloadAsync();
      } catch {
        // Show a "restart to apply" message here — do not fail silently.
      }
    }
  }, []);

  const rtl = isRTL(locale);
  const value: I18nContextValue = {
    locale,
    setLocale,
    rtl,
    t: useCallback((k, p) => translate(locale, k, p), [locale]),
    fDate: useCallback((d, s) => formatDate(d, locale, s), [locale]),
    fTime: useCallback((d) => formatTime(d, locale), [locale]),
    fCurrency: useCallback((m) => formatCurrency(m, locale), [locale]),
    row: 'row',
    // Constant per platform — must NOT depend on `rtl`, or it flips twice.
    textStart: (Platform.OS === 'web' ? 'start' : 'left') as 'left',
    textEnd: (Platform.OS === 'web' ? 'end' : 'right') as 'right',
    // TextInput does NOT auto-mirror, so this one MUST follow `rtl`.
    inputStart: (Platform.OS === 'web' ? 'start' : rtl ? 'right' : 'left') as 'left',
  };

  // Don't render half-directioned: wait for the stored locale.
  if (!ready) return null;

  return (
    <I18nContext.Provider value={value}>
      {/* WEB: `dir` installs react-native-web's LocaleProvider, which is what
          makes logical props (marginStart / paddingEnd / start / end) and RNW's
          own base textAlign:'start' resolve to the right side. CSS `direction`
          alone does NOT do this — RNW reads its own React context, which
          defaults to LTR. Native ignores `dir`; I18nManager already mirrored. */}
      <View style={styles.root} {...(Platform.OS === 'web' ? { dir: rtl ? 'rtl' : 'ltr' } : {})}>
        {children}
      </View>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
