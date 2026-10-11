import { useEffect, useRef, useState } from 'react'
import { DOCS_PAGES, docsRouteKey, type DocsSlug } from './docs/manifest'
import { localeFromPath, type Locale } from './i18n/locales'
import { currentLocale, msg } from './i18n/messages'

export type RouteName = 'home' | 'changelog' | 'privacy' | 'terms' | 'about' | `docs:${DocsSlug}`

const DOC_ROUTES = Object.fromEntries(
  DOCS_PAGES.map((page) => [
    `docs:${page.slug}`,
    { path: docsRouteKey(page.slug), title: `Memlore — ${page.title}` },
  ]),
) as Record<`docs:${DocsSlug}`, { path: string; title: string }>

export const ROUTES: Record<RouteName, { path: string; title: string }> = {
  home: { path: '/', title: 'Memlore — A little life. A lasting story.' },
  changelog: { path: '/changelog', title: 'Memlore — Changelog' },
  privacy: { path: '/privacy', title: 'Memlore — Privacy Policy' },
  terms: { path: '/terms', title: 'Memlore — Terms of Service' },
  about: { path: '/about', title: 'Memlore — About' },
  ...DOC_ROUTES,
}

const ROUTE_BY_PATH = new Map<string, RouteName>(
  (Object.keys(ROUTES) as RouteName[]).map((name) => [ROUTES[name].path, name]),
)

/** Splits `pathname` into its locale and route (see `normalizePath`). */
export function parsePath(pathname: string): { route: RouteName; locale: Locale } {
  const { locale, rest } = localeFromPath(pathname)
  return { route: normalizePath(rest), locale }
}

let legalTitles: Partial<Record<RouteName, string>> = {}

/** Localized `<title>`s for the legal pages, from the locale's markdown frontmatter. */
export function setLegalTitles(titles: Partial<Record<RouteName, string>>): void {
  legalTitles = titles
}

function routeTitle(route: RouteName): string {
  return route === 'home' ? msg().meta.homeTitle : (legalTitles[route] ?? ROUTES[route].title)
}

/**
 * `/privacy`, `/privacy.html` and `/privacy/` are the same route; `/docs` is the overview.
 * Unknown paths are null so a click can leave the browser to load the real file
 * (`/llms.txt`) instead of swapping the SPA to home.
 */
export function matchRoute(pathname: string): RouteName | null {
  const path = pathname
    .replace(/index\.html$/, '')
    .replace(/\.html$/, '')
    .replace(/\/+$/, '')
  if (path === '') return 'home'
  return ROUTE_BY_PATH.get(path) ?? null
}

/** Unknown paths are home for the initial load and for back/forward. */
export function normalizePath(pathname: string): RouteName {
  return matchRoute(pathname) ?? 'home'
}

export function useRoute(): RouteName {
  const [route, setRoute] = useState<RouteName>(() => parsePath(window.location.pathname).route)
  // Holds the route whose focus move already happened. Compared by value rather than a
  // "first run" boolean because StrictMode remounts effects while keeping refs.
  const focused = useRef<RouteName>(route)

  useEffect(() => {
    document.title = routeTitle(route)
    if (focused.current === route) return
    focused.current = route
    // A page load reset focus to the document start and made a screen reader announce
    // the new title; swapping the tree does neither, and `privacy -> terms` renders the
    // same component so focus would stay on the link that was clicked. `preventScroll`
    // leaves scrolling to the click handler below — otherwise the two fight under
    // `html { scroll-behavior: smooth }`.
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [route])

  useEffect(() => {
    const onPopState = () => setRoute(parsePath(window.location.pathname).route)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a') : null
      if (!anchor || anchor.hasAttribute('target') || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      const { locale, rest } = localeFromPath(url.pathname)
      const next = matchRoute(rest)
      // Another locale loads its own dictionary and shell: let the browser navigate.
      if (locale !== currentLocale()) return
      // Unknown paths (`/llms.txt`, other files) are real navigations, not SPA swaps to home.
      if (next === null) return
      // A link to the route we are already on (e.g. `/#demo` while on `/`) is a native
      // fragment jump the browser handles without a reload — never intercept it.
      if (next === route) return

      event.preventDefault()
      history.pushState(null, '', anchor.href)
      setRoute(next)
      const hash = url.hash.slice(1)
      if (hash) {
        // The target element only exists after the new route has rendered.
        requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView())
      } else {
        window.scrollTo(0, 0)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [route])

  return route
}
