import { LOCALES, type Locale } from './locales.ts'
import { en, type Messages } from './messages/en.ts'

let locale: Locale = LOCALES[0]
let messages: Messages = en

export function setLocale(next: Locale, nextMessages: Messages): void {
  locale = next
  messages = nextMessages
}

export function currentLocale(): Locale {
  return locale
}

export function msg(): Messages {
  return messages
}

/** Replaces `{name}` placeholders with `vars[name]`; unknown names stay as-is. */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}
