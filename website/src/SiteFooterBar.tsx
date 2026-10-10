import { ArrowUpRight } from 'lucide-react'
import { githubUrl } from './links'
import { localePath } from './i18n/locales'
import { currentLocale, format, msg } from './i18n/messages'

const FOOTER_WORDMARK = 'Memlore'

export function SiteFooterBar({
  homeHref,
  current,
}: {
  homeHref: string
  current?: 'privacy' | 'terms' | 'changelog' | 'about' | 'docs'
}) {
  const t = msg().chrome
  const locale = currentLocale()
  return (
    <>
      <p className="footer-copyright">{format(t.copyright, { year: new Date().getFullYear() })}</p>
      <div className="footer-bottom">
        <div className="footer-brand">
          <a className="footer-wordmark" href={homeHref}>
            {Array.from(FOOTER_WORDMARK).map((letter, index) => (
              <span className="footer-wordmark-letter" key={index}>
                {letter}
              </span>
            ))}
          </a>
        </div>
        <nav className="footer-links" aria-label={t.footerNavAria}>
          <a
            href={localePath(locale, 'about')}
            aria-current={current === 'about' ? 'page' : undefined}
          >
            {t.footerAbout}
          </a>
          <a
            href={localePath(locale, 'changelog')}
            aria-current={current === 'changelog' ? 'page' : undefined}
          >
            {t.footerChangelog}
          </a>
          <a
            href={localePath(locale, 'docs:overview')}
            aria-current={current === 'docs' ? 'page' : undefined}
          >
            {t.footerDocs}
          </a>
          <a
            href={localePath(locale, 'privacy')}
            aria-current={current === 'privacy' ? 'page' : undefined}
          >
            {t.footerPrivacy}
          </a>
          <a
            href={localePath(locale, 'terms')}
            aria-current={current === 'terms' ? 'page' : undefined}
          >
            {t.footerTerms}
          </a>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            {t.footerGitHub} <ArrowUpRight className="size-4" />
          </a>
        </nav>
      </div>
    </>
  )
}
