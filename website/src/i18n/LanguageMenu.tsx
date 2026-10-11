import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Globe } from 'lucide-react'
import type { RouteName } from '../router'
import { LOCALES, localePath } from './locales'
import { currentLocale, msg } from './messages'
import { rememberedLocale, rememberLocale, subscribe } from './preference'

/** Globe button opening a list of locales. Translated pages link to the same page in each locale; English-only pages just remember the choice. */
export function LanguageMenu({ translated, route }: { translated: boolean; route: RouteName }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const remembered = useSyncExternalStore(subscribe, rememberedLocale, () => null)
  const current = currentLocale()

  useEffect(() => {
    if (!open) return
    const close = (refocus: boolean) => {
      setOpen(false)
      if (refocus) buttonRef.current?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true)
    }
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  const label = msg().menu.label
  return (
    <div ref={rootRef} className="lang-menu">
      <button
        ref={buttonRef}
        type="button"
        className="lang-menu-button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Globe className="size-5" aria-hidden="true" />
      </button>
      {open ? (
        <ul className="lang-menu-list" aria-label={label}>
          {LOCALES.map((locale) => {
            const code = locale.code || 'en'
            if (translated) {
              const isCurrent = locale.code === current.code
              return (
                <li key={code}>
                  <a
                    href={localePath(locale, route)}
                    hrefLang={locale.hreflang}
                    lang={locale.htmlLang}
                    aria-current={isCurrent ? 'page' : undefined}
                    className="lang-menu-item"
                  >
                    {locale.nativeName}
                  </a>
                </li>
              )
            }
            const chosen = (remembered ?? 'en') === code
            return (
              <li key={code}>
                <button
                  type="button"
                  lang={locale.htmlLang}
                  aria-pressed={chosen}
                  className="lang-menu-item"
                  onClick={() => {
                    rememberLocale(code)
                    setOpen(false)
                    buttonRef.current?.focus()
                  }}
                >
                  {locale.nativeName}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
