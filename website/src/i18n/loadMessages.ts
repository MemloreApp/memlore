import type { Messages } from './messages/en'

const localeMessages = import.meta.glob<Messages>(['./messages/*.ts', '!./messages/en.ts'], {
  import: 'default',
})

/** Lazily loads the dictionary of a non-English locale `code`. */
export function loadMessages(code: string): Promise<Messages> {
  return localeMessages[`./messages/${code}.ts`]()
}
