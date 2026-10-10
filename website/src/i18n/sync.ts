/**
 * Translation sync check, shared by the Vite build and `pnpm website:i18n:refresh`.
 * Runs under `node --experimental-strip-types`: imports only `node:*` and
 * sibling i18n files, with explicit `.ts` suffixes.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LOCALES } from './locales.ts'
import { en } from './messages/en.ts'

const I18N_DIR = fileURLToPath(new URL('.', import.meta.url))
const LEGAL_DIR = fileURLToPath(new URL('../legal/', import.meta.url))
const WEBSITE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const LEGAL_PAGES = ['about', 'privacy', 'terms'] as const
const LINKED_PAGES = ['about', 'privacy', 'terms']

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** Flattens nested objects/arrays into `{ 'a.b.0.c': value }`. */
export function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      Object.assign(out, flatten(value, prefix ? `${prefix}.${key}` : key))
    }
  } else {
    out[prefix] = String(obj)
  }
  return out
}

function frontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (!match) return out
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':')
    if (sep > 0) out[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  return out
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',')
}

function englishLinks(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/(?:\]\(|href=["'])\/([a-z-]+)(\.html)?(?=[)"'#?/])/g)) {
    if (LINKED_PAGES.includes(m[1])) found.add(m[1] + (m[2] ?? ''))
  }
  return [...found]
}

const nonEnglish = () => LOCALES.filter((l) => l.code !== '').map((l) => l.code as string)

async function loadMessages(code: string): Promise<Record<string, string>> {
  const mod = (await import(new URL(`./messages/${code}.ts`, import.meta.url).href)) as Record<
    string,
    unknown
  >
  return flatten(mod[code] ?? mod.default)
}

function readSidecar(code: string): Record<string, string> | null {
  const path = `${I18N_DIR}messages/${code}.sync.json`
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
    : null
}

function checkEnglishShells(problems: string[]): void {
  const expected: Record<string, { title: string; description: string }> = {
    index: { title: en.meta.homeTitle, description: en.meta.homeDescription },
  }
  for (const name of LEGAL_PAGES) {
    const fm = frontmatter(readFileSync(`${LEGAL_DIR}${name}.md`, 'utf8'))
    expected[name] = { title: fm.title ?? '', description: fm.description ?? '' }
  }
  for (const [name, want] of Object.entries(expected)) {
    const html = readFileSync(`${WEBSITE_DIR}${name}.html`, 'utf8')
    const title = unescapeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1].trim() ?? '')
    const description = unescapeHtml(
      html.match(/name="description"\s+content="([^"]*)"/)?.[1].trim() ?? '',
    )
    if (title !== want.title) problems.push(`en  ${name}.html  <title> differs from its source`)
    if (description !== want.description) {
      problems.push(`en  ${name}.html  description differs from its source`)
    }
  }
}

export async function checkSync(): Promise<string[]> {
  const problems: string[] = []
  checkEnglishShells(problems)
  const english = flatten(en)
  for (const code of nonEnglish()) {
    const local = await loadMessages(code)
    const sidecar = readSidecar(code) ?? {}
    for (const [key, value] of Object.entries(english)) {
      if (!(key in local)) {
        problems.push(`${code}  ${key}  missing translation`)
        continue
      }
      if (sidecar[key] !== hashOf(value)) {
        problems.push(`${code}  ${key}  English changed since translation`)
      }
      if (placeholders(value) !== placeholders(local[key])) {
        problems.push(`${code}  ${key}  placeholder mismatch {${placeholders(value)}}`)
      }
      for (const page of englishLinks(local[key])) {
        problems.push(
          `${code}  ${key}  links to English page /${page} (use /${code}/${page.replace('.html', '')})`,
        )
      }
    }
    for (const key of Object.keys(local)) {
      if (!(key in english)) problems.push(`${code}  ${key}  extra key`)
    }
    for (const name of LEGAL_PAGES) {
      const label = `legal/${name}.md`
      const path = `${LEGAL_DIR}${code}/${name}.md`
      if (!existsSync(path)) {
        problems.push(`${code}  ${label}  missing translation`)
        continue
      }
      const source = readFileSync(path, 'utf8')
      const hash = frontmatter(source).sourceHash
      if (!hash) problems.push(`${code}  ${label}  missing sourceHash`)
      else if (hash !== hashOf(readFileSync(`${LEGAL_DIR}${name}.md`, 'utf8'))) {
        problems.push(`${code}  ${label}  English changed since translation`)
      }
      for (const page of englishLinks(source)) {
        // The "English version prevails" notice may link its own English original.
        if (page === name && (name === 'privacy' || name === 'terms')) continue
        problems.push(
          `${code}  ${label}  links to English page /${page} (use /${code}/${page.replace('.html', '')})`,
        )
      }
    }
  }
  if (problems.length > 0) {
    problems.push('translate, then run: pnpm website:i18n:refresh <locale>')
  }
  return problems
}

/** Records the current English hashes as translated for each locale in `codes`. */
export function writeSync(codes: string[] = nonEnglish()): void {
  const english = flatten(en)
  for (const code of codes) {
    const sidecar = Object.fromEntries(Object.entries(english).map(([k, v]) => [k, hashOf(v)]))
    writeFileSync(`${I18N_DIR}messages/${code}.sync.json`, `${JSON.stringify(sidecar, null, 2)}\n`)
    for (const name of LEGAL_PAGES) {
      const path = `${LEGAL_DIR}${code}/${name}.md`
      if (!existsSync(path)) continue
      const line = `sourceHash: ${hashOf(readFileSync(`${LEGAL_DIR}${name}.md`, 'utf8'))}`
      const source = readFileSync(path, 'utf8')
      const next = /^sourceHash:.*$/m.test(source)
        ? source.replace(/^sourceHash:.*$/m, () => line)
        : source.replace(/^---\r?\n/, (open) => `${open}${line}\n`)
      if (next !== source) writeFileSync(path, next)
    }
  }
}
