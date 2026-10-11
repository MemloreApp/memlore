import { escapeHtml } from './legal/markdown'
import { githubUrl } from './links'
import type { Locale } from './i18n/locales'
import type { Messages } from './i18n/messages/en'

/**
 * Static twin of the landing page's headline copy, injected into index.html at
 * build time. Google's OAuth reviewer fetches raw HTML and runs no JS: on the
 * client-rendered shell it sees no app description and no privacy policy link,
 * both of which their homepage requirements demand. Every string comes from the
 * same dictionary the React page renders — never crawler-only text.
 */
export function renderLandingStaticHtml(messages: Messages, locale: Locale): string {
  const { chrome, landing, meta } = messages
  const hero = landing.hero
  // Docs and the changelog are English-only and live at the site root.
  const root = locale.code === '' ? '' : '../'
  const section = (title: string, body: string) =>
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>`
  return [
    '<main id="main">',
    `<h1>${escapeHtml(`${hero.titleLead} ${hero.titleTail}`)}</h1>`,
    `<p>${escapeHtml(`${hero.descriptionLead} ${hero.descriptionTail}`)}</p>`,
    `<p>${escapeHtml(meta.homeDescription)}</p>`,
    section(landing.encrypt.title, landing.encrypt.text),
    section(landing.sync.title, landing.sync.text),
    // These stay on their `.html` form on purpose: only crawlers and JS-off visitors
    // ever see this nav, and `https://memlore.app/privacy.html` is the exact URL
    // registered in Memlore's Google OAuth consent screen (docs/gdrive-oauth-setup.md).
    // React replaces this markup with the clean `/privacy` URLs on mount.
    `<nav aria-label="${escapeHtml(chrome.footerNavAria)}">`,
    `<a href="index.html">${'Memlore'}</a>`,
    `<a href="about.html">${escapeHtml(chrome.footerAbout)}</a>`,
    `<a href="${root}changelog.html">${escapeHtml(chrome.footerChangelog)}</a>`,
    `<a href="${root}docs/index.html">${escapeHtml(chrome.footerDocs)}</a>`,
    `<a href="privacy.html">${escapeHtml(chrome.footerPrivacy)}</a>`,
    `<a href="terms.html">${escapeHtml(chrome.footerTerms)}</a>`,
    `<a href="${root}llms.txt">llms.txt</a>`,
    `<a href="${escapeHtml(githubUrl)}">${escapeHtml(chrome.footerGitHub)}</a>`,
    '</nav>',
    '</main>',
  ].join('')
}
