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
