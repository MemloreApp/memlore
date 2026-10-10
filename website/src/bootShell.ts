import { DOCS_PAGES, type DocsSlug } from './docs/manifest'
import { LOCALES, type Locale } from './i18n/locales'

/** Empty-root marker the Vite plugin replaces with the crawler twin. */
export const ROOT_MARKER = '<div id="root"></div>'

const LOGO_SRC = '/logo-without-container/256.png'

const PAPER_DARK = 'oklch(0.145 0.004 55)'
const INK_DARK = 'oklch(0.985 0.002 55)'

/**
 * Inline first-paint splash. CSS is a JS import, so this style has to ship
 * in the HTML shell or JS users see the classless crawler twin.
 */
export function renderBootStyle(): string {
  return `<style id="site-boot-style">
html:not(.site-ready),
html:not(.site-ready) body {
  background: ${PAPER_DARK};
}
html:not(.site-ready) #root {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.site-boot {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${PAPER_DARK};
  color: ${INK_DARK};
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.site-boot-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  animation: site-boot-breathe 2.8s ease-in-out infinite;
}
.site-boot-brand img {
  display: block;
  width: 2.75rem;
  height: 2.75rem;
}
.site-boot-brand span {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
@keyframes site-boot-breathe {
  50% { opacity: 0.72; }
}
@media (prefers-reduced-motion: reduce) {
  .site-boot-brand {
    animation: none;
  }
}
html.site-ready .site-boot {
  display: none;
}
</style>`
}

export function renderBootSplash(): string {
  return `<div class="site-boot" aria-hidden="true"><div class="site-boot-brand"><img src="${LOGO_SRC}" alt="" width="44" height="44" /><span>Memlore</span></div></div>`
}

export function renderBootNoscript(): string {
  return `<noscript><style>
html:not(.site-ready) #root {
  position: static;
  width: auto;
  height: auto;
  padding: 0;
  margin: 0;
  overflow: visible;
  clip: auto;
  clip-path: none;
  white-space: normal;
}
.site-boot {
  display: none !important;
}
</style></noscript>`
}

export function injectBootShell(html: string): string {
  if (!html.includes('</head>')) {
    throw new Error('boot shell: </head> not found')
  }
  if (!html.includes(ROOT_MARKER)) {
    throw new Error(`boot shell: ${ROOT_MARKER} not found`)
  }
  return html
    .replace('</head>', () => `${renderBootStyle()}</head>`)
    .replace(ROOT_MARKER, () => `${renderBootSplash()}${renderBootNoscript()}${ROOT_MARKER}`)
}

const DOCS_HTML_TO_SLUG = new Map<string, DocsSlug>(
  DOCS_PAGES.map((page) => [page.slug === 'overview' ? 'index' : page.slug, page.slug]),
)

const DOC_FILE = [...DOCS_HTML_TO_SLUG.keys()].join('|')

const LOCALE_CODES: string[] = LOCALES.map((locale) => locale.code).filter((code) => code !== '')

/** Optional `<code>/` group for index/about/privacy/terms; matches nothing while English is alone. */
const LOCALE_PREFIX = LOCALE_CODES.length ? `(?:(?:${LOCALE_CODES.join('|')})/)?` : ''

const MARKETING_SHELL = new RegExp(
  `(?:^|/)(?:${LOCALE_PREFIX}(?:index|about|privacy|terms)\\.html|changelog\\.html|docs/(?:${DOC_FILE})\\.html)$`,
)

const LEGAL_NAMES = ['privacy', 'terms', 'about'] as const

type LegalName = (typeof LEGAL_NAMES)[number]

function isLegalName(value: string): value is LegalName {
  return (LEGAL_NAMES as readonly string[]).includes(value)
}

/**
 * `docs/` is checked first so `docs/index.html` is not the landing page and
 * `docs/how-privacy-works.html` is not the privacy policy. Landing and legal
 * shells are a bare filename or an absolute path, not any nested relative file
 * that happens to end in `index.html` or `privacy.html`.
 */
export function twinKindFor(
  path: string,
):
  | { kind: 'landing'; locale: Locale }
  | { kind: 'legal'; name: LegalName; locale: Locale }
  | { kind: 'docs'; slug: DocsSlug; locale: Locale }
  | undefined {
  const normalized = path.replace(/\\/g, '/')
  const docsFile = normalized.match(/(?:^|\/)docs\/([^/]+)\.html$/)
  if (docsFile) {
    const slug = DOCS_HTML_TO_SLUG.get(docsFile[1] ?? '')
    return slug ? { kind: 'docs', slug, locale: LOCALES[0] } : undefined
  }
  const root = rootHtmlName(normalized)
  if (!root) return undefined
  const { file, locale } = root
  if (file === 'index') return { kind: 'landing', locale }
  if (isLegalName(file)) return { kind: 'legal', name: file, locale }
  return undefined
}

/**
 * The last segment of an absolute path, or a bare filename. A non-English
 * locale code as the parent segment (`/fr/privacy.html`, `fr/privacy.html`)
 * selects that locale; any other relative nesting is not a root shell.
 */
function rootHtmlName(path: string): { file: string; locale: Locale } | undefined {
  const match = path.match(/(?:^|\/)(?:([^/]+)\/)?([^/]+)\.html$/)
  const file = match?.[2]
  if (!match || !file) return undefined
  const locale = LOCALES.find((l) => l.code !== '' && l.code === match[1])
  if (locale && (path.startsWith('/') || match.index === 0)) return { file, locale }
  if (!path.includes('/') || path.startsWith('/')) return { file, locale: LOCALES[0] }
  return undefined
}

/** Inject the splash, then (optionally) the crawler twin — splash stays a sibling of #root. */
export function applyMarketingShell(html: string, path: string, article?: string): string {
  if (!MARKETING_SHELL.test(path)) return html
  const withBoot = injectBootShell(html)
  if (!article) return withBoot
  if (!withBoot.includes(ROOT_MARKER)) {
    throw new Error(`prerender-static-shells: ${ROOT_MARKER} not found in ${path}`)
  }
  return withBoot.replace(ROOT_MARKER, () => `<div id="root">${article}</div>`)
}
