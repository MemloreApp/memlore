/**
 * Website locales. English is the unprefixed default (`code: ''`); every other
 * locale lives under `/<code>/`. Shared with Node build scripts, so this file
 * imports nothing.
 */

export const LOCALES = [
  {
    code: '',
    htmlLang: 'en',
    hreflang: 'en',
    ogLocale: 'en_US',
    intl: 'en-US',
    /** Locale for long dates; English keeps the day-month-year order. */
    dateIntl: 'en-GB',
    nativeName: 'English',
  },
  {
    code: 'es',
    htmlLang: 'es',
    hreflang: 'es',
    ogLocale: 'es_ES',
    intl: 'es-ES',
    dateIntl: 'es-ES',
    nativeName: 'Español',
  },
  {
    code: 'fr',
    htmlLang: 'fr',
    hreflang: 'fr',
    ogLocale: 'fr_FR',
    intl: 'fr-FR',
    dateIntl: 'fr-FR',
    nativeName: 'Français',
  },
  {
    code: 'vi',
    htmlLang: 'vi',
    hreflang: 'vi',
    ogLocale: 'vi_VN',
    intl: 'vi-VN',
    dateIntl: 'vi-VN',
    nativeName: 'Tiếng Việt',
  },
  {
    code: 'zh-hans',
    htmlLang: 'zh-Hans',
    hreflang: 'zh-Hans',
    ogLocale: 'zh_CN',
    intl: 'zh-Hans-CN',
    dateIntl: 'zh-Hans-CN',
    nativeName: '简体中文',
  },
  {
    code: 'zh-hant',
    htmlLang: 'zh-Hant',
    hreflang: 'zh-Hant',
    ogLocale: 'zh_TW',
    intl: 'zh-Hant-TW',
    dateIntl: 'zh-Hant-TW',
    nativeName: '繁體中文',
  },
  {
    code: 'ja',
    htmlLang: 'ja',
    hreflang: 'ja',
    ogLocale: 'ja_JP',
    intl: 'ja-JP',
    dateIntl: 'ja-JP',
    nativeName: '日本語',
  },
  {
    code: 'pt',
    htmlLang: 'pt-BR',
    hreflang: 'pt',
    ogLocale: 'pt_BR',
    intl: 'pt-BR',
    dateIntl: 'pt-BR',
    nativeName: 'Português',
  },
  {
    code: 'de',
    htmlLang: 'de',
    hreflang: 'de',
    ogLocale: 'de_DE',
    intl: 'de-DE',
    dateIntl: 'de-DE',
    nativeName: 'Deutsch',
  },
] as const

export type Locale = (typeof LOCALES)[number]

export type LocaleCode = Locale['code']

/** Mirrors `RouteName` in `router.ts` without importing React code. */
type WebsiteRoute = 'home' | 'about' | 'privacy' | 'terms' | 'changelog' | `docs:${string}`

const ENGLISH: Locale = LOCALES[0]

/** Splits a leading locale segment off `pathname`; `rest` always starts with `/`. */
export function localeFromPath(pathname: string): { locale: Locale; rest: string } {
  for (const locale of LOCALES) {
    if (locale.code === '') continue
    const prefix = `/${locale.code}`
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { locale, rest: pathname.slice(prefix.length) || '/' }
    }
  }
  return { locale: ENGLISH, rest: pathname }
}

/** Path of `route` in `locale`. Docs and the changelog stay English-only. */
export function localePath(locale: Locale, route: WebsiteRoute): string {
  if (route.startsWith('docs:')) {
    const slug = route.slice('docs:'.length)
    return slug === 'overview' ? '/docs/' : `/docs/${slug}`
  }
  if (route === 'changelog') return '/changelog'
  const prefix = locale.code === '' ? '' : `/${locale.code}`
  if (route === 'home') return `${prefix}/`
  return `${prefix}/${route}`
}
