/**
 * Marks locales as translated against the current English source:
 * `pnpm website:i18n:refresh [code...]` (default: every non-English locale).
 */
import { LOCALES } from '../src/i18n/locales.ts'
import { writeSync } from '../src/i18n/sync.ts'

const known: string[] = LOCALES.filter((l) => l.code !== '').map((l) => l.code)
// The website tsconfig types `process` as Vite's browser shim, so read argv untyped.
const { argv } = (globalThis as unknown as { process: { argv: string[] } }).process
const args = argv.slice(2)
const unknown = args.filter((code: string) => !known.includes(code))
if (unknown.length > 0) {
  throw new Error(`unknown locale: ${unknown.join(', ')} (known: ${known.join(', ') || 'none'})`)
}
const codes = args.length > 0 ? args : known
writeSync(codes)
console.log(codes.length > 0 ? `refreshed: ${codes.join(', ')}` : 'no non-English locales')
