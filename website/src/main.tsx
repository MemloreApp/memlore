import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import LandingPage from './LandingPage'
import ChangelogPage from './changelog/ChangelogPage'
import DocsPage from './docs/DocsPage'
import { DOCS_PAGES, type DocsSlug } from './docs/manifest'
import LegalPage from './legal/LegalPage'
import { parseLegalMarkdown } from './legal/markdown'
import aboutMarkdown from './legal/about.md?raw'
import privacyMarkdown from './legal/privacy.md?raw'
import termsMarkdown from './legal/terms.md?raw'
import { localeFromPath } from './i18n/locales'
import { setLocale } from './i18n/messages'
import { en, type Messages } from './i18n/messages/en'
import { setLegalTitles, useRoute } from './router'
import './styles.css'

type LegalKind = 'about' | 'privacy' | 'terms'

const localeMessages = import.meta.glob<Messages>(
  ['./i18n/messages/*.ts', '!./i18n/messages/en.ts'],
  {
    import: 'default',
  },
)

const localeLegal = import.meta.glob<string>('./legal/*/*.md', { query: '?raw', import: 'default' })

let legalMarkdown: Record<LegalKind, string> = {
  about: aboutMarkdown,
  privacy: privacyMarkdown,
  terms: termsMarkdown,
}

const docsMarkdown = import.meta.glob<string>('./docs/content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function docsSource(slug: DocsSlug): string {
  const loaded = docsMarkdown[`./docs/content/${slug}.md`]
  if (typeof loaded === 'string') return loaded
  const page = DOCS_PAGES.find((item) => item.slug === slug)
  const title = page?.title ?? slug
  const description = page?.description ?? title
  return `---
title: ${title}
description: ${description}
updated: 2026-09-25
---

# ${title}
`
}

function docsSlug(route: `docs:${DocsSlug}`): DocsSlug {
  const slug = route.slice('docs:'.length)
  const page = DOCS_PAGES.find((item) => item.slug === slug)
  if (!page) throw new Error(`unknown docs route: ${route}`)
  return page.slug
}

function Site() {
  const route = useRoute()
  switch (route) {
    case 'changelog':
      return <ChangelogPage />
    case 'privacy':
      return <LegalPage kind="privacy" source={legalMarkdown.privacy} />
    case 'terms':
      return <LegalPage kind="terms" source={legalMarkdown.terms} />
    case 'about':
      return <LegalPage kind="about" source={legalMarkdown.about} />
    case 'home':
      return <LandingPage />
    default: {
      const slug = docsSlug(route)
      return <DocsPage slug={slug} source={docsSource(slug)} />
    }
  }
}

function BootGate({ children }: { children: ReactNode }) {
  // render() is async — flipping this class here would show the crawler twin
  // before React replaces it. Wait for the first commit.
  useEffect(() => {
    document.documentElement.classList.add('site-ready')
  }, [])
  return children
}

async function loadLocale(): Promise<void> {
  const locale = localeFromPath(window.location.pathname).locale
  if (locale.code === '') {
    setLocale(locale, en)
    return
  }
  const dir = `./legal/${locale.code}/`
  const [messages, about, privacy, terms] = await Promise.all([
    localeMessages[`./i18n/messages/${locale.code}.ts`](),
    localeLegal[`${dir}about.md`](),
    localeLegal[`${dir}privacy.md`](),
    localeLegal[`${dir}terms.md`](),
  ])
  legalMarkdown = { about, privacy, terms }
  setLegalTitles({
    about: parseLegalMarkdown(about).meta.title,
    privacy: parseLegalMarkdown(privacy).meta.title,
    terms: parseLegalMarkdown(terms).meta.title,
  })
  setLocale(locale, messages)
}

void loadLocale().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BootGate>
        <Site />
      </BootGate>
    </StrictMode>,
  ),
)
