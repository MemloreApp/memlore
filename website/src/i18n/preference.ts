const KEY = 'memlore.site.locale'

const listeners = new Set<() => void>()

/** Remembers the visitor's locale (`'en'` for English); storage failures are ignored. */
export function rememberLocale(code: string): void {
  try {
    localStorage.setItem(KEY, code)
  } catch {
    // Storage unavailable (private mode, disabled): nothing to remember.
  }
  listeners.forEach((fn) => fn())
}

export function rememberedLocale(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Calls `fn` after every `rememberLocale`; returns the unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
