import { useEffect, useState, useSyncExternalStore } from 'react'
import { loadMessages } from './loadMessages'
import { LOCALES, localePath } from './locales'
import type { Messages } from './messages/en'
import { rememberedLocale, subscribe } from './preference'

/** Client-only note, in the remembered language, that the page is English-only. */
export function UntranslatedNotice() {
  const remembered = useSyncExternalStore(subscribe, rememberedLocale, () => null)
  const locale = LOCALES.find((item) => item.code !== '' && item.code === remembered)
  const [loaded, setLoaded] = useState<{ code: string; messages: Messages } | null>(null)

  useEffect(() => {
    if (!locale) return
    let cancelled = false
    void loadMessages(locale.code).then(
      (messages) => {
        if (!cancelled) setLoaded({ code: locale.code, messages })
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [locale])

  if (!locale || loaded?.code !== locale.code) return null
  const { notice } = loaded.messages
  return (
    <p className="untranslated-notice" role="note" lang={locale.htmlLang}>
      {notice.onlyEnglish} <a href={localePath(locale, 'home')}>{notice.backHome}</a>
    </p>
  )
}
