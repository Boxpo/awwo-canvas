export type UiLocale = 'en' | 'zh';

export const LOCALE_STORAGE_KEY = 'awwo.locale';

export function localeFromLanguage(language: string | null | undefined): UiLocale {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function readInitialLocale(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  language: string | null | undefined = typeof navigator === 'undefined' ? 'en' : navigator.language,
): UiLocale {
  try {
    const stored = storage?.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // Storage may be unavailable in hardened webviews; the host language remains safe.
  }
  return localeFromLanguage(language);
}

export function localeHtmlLang(locale: UiLocale): 'en' | 'zh-CN' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
