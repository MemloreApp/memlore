// Minimal lookup over the desktop's shared auth strings (src/locales, watched
// by Metro). English by default, Vietnamese when the device language is.
import en from '../../src/locales/en/auth.json';
import vi from '../../src/locales/vi/auth.json';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends object
      ? Leaves<T[K], `${P}${K}.`>
      : never;
}[keyof T & string];

export type AuthKey = Leaves<typeof en>;

const table = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('vi')
  ? vi
  : en;

function lookup(strings: unknown, key: string): string | undefined {
  let node = strings;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function t(key: AuthKey, vars?: Record<string, string | number>): string {
  const raw = lookup(table, key) ?? lookup(en, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
