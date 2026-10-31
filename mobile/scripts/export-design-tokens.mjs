#!/usr/bin/env node
// Export the desktop design tokens (src/styles/globals.css) for the mobile
// Unistyles themes (plan phase 16.1). Writes mobile/src/theme/tokens.generated.json.
//
//   pnpm tokens:export            write the JSON
//   pnpm tokens:export --check    exit 1 when the JSON is stale
//
// Both modes print the WCAG table and exit 1 when a declared pair is below
// 4.5:1 (the CLAUDE.md contrast guard, run as a script).
//
// How the CSS is read: rule blocks are collected by selector, never by line
// number. Only the token blocks count (`@theme`, `:root`, `.dark`,
// `.dark.surface-soft`, `.dark.surface-lumen`, `:root.ds-clean`,
// `:root.dark.ds-clean`, `:root.ds-clay`, `:root.dark.ds-clay`, and their
// `.rad-medium` / `.rad-high` forms). Several blocks share a selector; each
// theme takes them through the real cascade (specificity, then source order),
// with `@theme` as the lowest layer and Tailwind's `@theme default` (the
// radius ladder Signature does not restate) below it. A custom property an
// exported token needs that no block defines is an error.
//
// The script lives in mobile/ so `culori` resolves from mobile/node_modules
// and the root lockfile stays untouched.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  formatHex,
  formatHex8,
  interpolateWithPremultipliedAlpha,
  parse,
  toGamut,
  wcagContrast,
} from 'culori'

const GLOBALS_CSS = new URL('../../src/styles/globals.css', import.meta.url)
const TAILWIND_THEME_CSS = new URL('../../node_modules/tailwindcss/theme.css', import.meta.url)
const OUT = new URL('../src/theme/tokens.generated.json', import.meta.url)
const check = process.argv.includes('--check')

/** Token blocks the export reads. `.rad-*` forms of these are added below. */
const TOKEN_SELECTORS = [
  '@theme',
  ':root',
  '.dark',
  '.dark.surface-soft',
  '.dark.surface-lumen',
  ':root.ds-clean',
  ':root.dark.ds-clean',
  ':root.ds-clay',
  ':root.dark.ds-clay',
]
const RADIUS_VARIANTS = ['medium', 'high']

/** The 8 themes: the classes `src/lib/designSystem.ts` stamps on <html>. */
const THEMES = {
  signatureLight: ['ds-signature'],
  signatureDark: ['ds-signature', 'dark'],
  signatureDarkSoft: ['ds-signature', 'dark', 'surface-soft'],
  signatureDarkLumen: ['ds-signature', 'dark', 'surface-lumen'],
  cleanLight: ['ds-clean'],
  cleanDark: ['ds-clean', 'dark'],
  clayLight: ['ds-clay'],
  clayDark: ['ds-clay', 'dark'],
}

/** Corner radius levels (designSystem.ts CornerRadius): low stamps no class. */
const CORNER_RADII = { low: null, medium: 'rad-medium', high: 'rad-high' }

const RADII = {
  xs: '--radius-xs',
  sm: '--radius-sm',
  md: '--radius-md',
  lg: '--radius-lg',
  xl: '--radius-xl',
  '2xl': '--radius-2xl',
  button: '--button-radius',
}
const ELEVATION = { 1: '--elev-1', 2: '--elev-2', 3: '--elev-3', 4: '--elev-4' }
const FONTS = {
  sans: '--font-sans',
  display: '--font-display',
  title: '--font-title',
  mono: '--font-mono',
}

/** WCAG AA pairs (foreground on background), checked on every theme. */
const WCAG_MIN = 4.5
const WCAG_PAIRS = [
  ['fg', 'panel1'],
  ['fg', 'panel2'],
  ['fg', 'elevated'],
  ['fgSecondary', 'panel1'],
  ['fgSecondary', 'panel2'],
  ['fgSecondary', 'elevated'],
  ['fgInverse', 'accent'],
]

/**
 * Mobile-only overrides, applied after the desktop values resolve. Desktop
 * tokens are never retuned for mobile; an entry here exists only because the
 * desktop value fails a WCAG pair above, and is recorded in docs/LATER.md.
 * The value is another token of the same theme.
 *
 * `accent` (dark themes and Clay light): the chrome accent is art-directed
 * light (globals.css, comment on `--color-accent-fill`: it "only clears
 * ~2.3–3.6:1 against white — fine for icons and short chrome, not for wrapped
 * paragraphs"). Clean and Clay get their accent inline from `applyAccent`, so
 * from globals.css alone they inherit the Signature value. The desktop puts
 * button labels on `--color-accent-fill` (Clay: `--cta-face`, the same fill
 * at L 0.52); mobile buttons paint `accent`, so it takes the fill. Links use
 * `accentText`, never `accent`.
 *
 * `fgInverse` (Clay dark): the Clay dark inverse `#f0ebe3` stays below 4.5:1
 * even on the fill (4.22:1). The desktop Clay primary button labels its face
 * with `--cta-ink` (white), not `--color-fg-inverse`; mobile does the same.
 */
const MOBILE_OVERRIDES = {
  signatureDark: { accent: '--color-accent-fill' },
  signatureDarkSoft: { accent: '--color-accent-fill' },
  signatureDarkLumen: { accent: '--color-accent-fill' },
  cleanDark: { accent: '--color-accent-fill' },
  clayLight: { accent: '--color-accent-fill' },
  clayDark: { accent: '--color-accent-fill', fgInverse: '--cta-ink' },
}

// ── CSS parsing ─────────────────────────────────────────────────────────────

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Top-level rules `{ prelude, body }`, recursing into at-rule bodies. */
function parseRules(css, nested = false, out = []) {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    // A statement before the block (`@import …;`) ends at its `;`.
    let start = i
    const semi = css.lastIndexOf(';', open)
    if (semi >= start) start = semi + 1
    const prelude = css.slice(start, open).trim()
    let depth = 0
    let close = open
    for (; close < css.length; close++) {
      if (css[close] === '{') depth++
      else if (css[close] === '}' && --depth === 0) break
    }
    if (depth !== 0) throw new Error(`unbalanced braces after "${prelude}"`)
    const body = css.slice(open + 1, close)
    const isAtRule = prelude.startsWith('@') && !/^@theme\b/.test(prelude)
    if (isAtRule) parseRules(body, true, out)
    else out.push({ prelude: prelude.replace(/\s+/g, ' '), body, nested })
    i = close + 1
  }
  return out
}

/** `--name: value` declarations of a block, split on `;` outside parentheses. */
function declarations(body) {
  const decls = []
  let depth = 0
  let current = ''
  for (const ch of `${body};`) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) {
      const colon = current.indexOf(':')
      const name = current.slice(0, colon).trim()
      if (colon > 0 && name.startsWith('--')) {
        decls.push([name, current.slice(colon + 1).trim().replace(/\s+/g, ' ')])
      }
      current = ''
    } else current += ch
  }
  return decls
}

/** Selector → { classes, specificity }, or null when it is not a token block. */
function tokenSelector(selector) {
  if (selector === '@theme') return { classes: [], layer: 1, specificity: 0 }
  const variant = selector.match(/^(.*)\.rad-(medium|high)$/)
  const stem = variant ? variant[1] : selector
  if (!(TOKEN_SELECTORS.includes(stem) || (variant && ['', ':root'].includes(stem)))) return null
  const classes = selector.split('.').slice(1)
  const root = selector.startsWith(':root') ? 1 : 0
  return { classes, layer: 2, specificity: root + classes.length }
}

/** Every token declaration with its cascade weight. */
function collectDeclarations() {
  const decls = []
  let order = 0
  // Tailwind's own defaults: lowest layer, first `@theme default` block only.
  const tailwind = parseRules(stripComments(readFileSync(TAILWIND_THEME_CSS, 'utf8')))
  const defaults = tailwind.find((r) => r.prelude === '@theme default')
  if (!defaults) throw new Error('tailwindcss/theme.css: no `@theme default` block')
  for (const [name, value] of declarations(defaults.body)) {
    decls.push({ name, value, classes: [], layer: 0, specificity: 0, order: order++ })
  }

  for (const rule of parseRules(stripComments(readFileSync(GLOBALS_CSS, 'utf8')))) {
    for (const selector of splitTopLevel(rule.prelude, ',')) {
      const token = tokenSelector(selector)
      if (!token) continue
      if (rule.nested) {
        throw new Error(`globals.css: token block "${selector}" inside an at-rule is not supported`)
      }
      if (rule.body.includes('{')) {
        throw new Error(`globals.css: token block "${selector}" has nested rules (not supported)`)
      }
      for (const [name, value] of declarations(rule.body)) {
        decls.push({ name, value, ...token, order: order++ })
      }
    }
  }
  return decls
}

/** The winning declaration per property for an <html> class set. */
function cascade(decls, classes) {
  const winners = new Map()
  for (const d of decls) {
    if (!d.classes.every((c) => classes.includes(c))) continue
    const prev = winners.get(d.name)
    const beats =
      !prev ||
      d.layer > prev.layer ||
      (d.layer === prev.layer && d.specificity > prev.specificity) ||
      (d.layer === prev.layer && d.specificity === prev.specificity && d.order > prev.order)
    if (beats) winners.set(d.name, d)
  }
  return new Map([...winners].map(([name, d]) => [name, d.value]))
}

/** Value of `name` with every var() resolved; throws on a missing property. */
function resolve(props, name, theme, chain = []) {
  if (chain.includes(name)) throw new Error(`${theme}: var() cycle ${[...chain, name].join(' → ')}`)
  const value = props.get(name)
  if (value === undefined) {
    const via = chain.length ? ` (via ${chain.join(' → ')})` : ''
    throw new Error(`${theme}: custom property ${name} is not defined${via}`)
  }
  return substituteVars(value, (ref, fallback) => {
    if (!props.has(ref) && fallback !== undefined) return fallback
    return resolve(props, ref, theme, [...chain, name])
  })
}

function substituteVars(value, lookup) {
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) return out + value.slice(i)
    out += value.slice(i, at)
    let depth = 0
    let end = at + 3
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++
      else if (value[end] === ')' && --depth === 0) break
    }
    const [ref, fallback] = splitTopLevel(value.slice(at + 4, end), ',', 2)
    out += lookup(ref.trim(), fallback?.trim())
    i = end + 1
  }
  return out
}

/** Split on `sep` outside parentheses (at most `limit` parts). */
function splitTopLevel(text, sep, limit = Infinity) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === sep && depth === 0 && parts.length < limit - 1) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim())
}

// ── Values ──────────────────────────────────────────────────────────────────

const toRgb = toGamut('rgb')

/** CSS colour → `#rrggbb` (opaque) or `#rrggbbaa`, gamut-mapped to sRGB. */
function hex(css, where) {
  const color = parseColor(css, where)
  const rgb = toRgb(color)
  return (rgb.alpha ?? 1) < 1 ? formatHex8(rgb) : formatHex(rgb)
}

function parseColor(css, where) {
  const mix = css.match(/^color-mix\(\s*in oklab\s*,(.*)\)$/)
  if (mix) {
    const [a, b] = splitTopLevel(mix[1], ',').map((part) => {
      const pct = part.match(/\s+(\d+(?:\.\d+)?)%$/)
      return { color: parseColor(pct ? part.slice(0, pct.index) : part, where), pct: pct && +pct[1] }
    })
    const pa = a.pct ?? (b.pct === null ? 50 : 100 - b.pct)
    const pb = b.pct ?? 100 - pa
    if (pa + pb !== 100) throw new Error(`${where}: color-mix percentages must sum to 100: ${css}`)
    return interpolateWithPremultipliedAlpha([a.color, b.color], 'oklab')(pb / 100)
  }
  const color = parse(css)
  if (!color) throw new Error(`${where}: cannot parse colour "${css}"`)
  return color
}

/** CSS length → px number (16px root, rounded to 2 decimals). */
function px(css, where) {
  const m = css.match(/^(-?\d*\.?\d+)(px|rem)?$/)
  if (!m || (m[2] === undefined && +m[1] !== 0)) throw new Error(`${where}: unsupported length "${css}"`)
  return Math.round(+m[1] * (m[2] === 'rem' ? 16 : 1) * 100) / 100
}

/** box-shadow → RN `boxShadow` array (`none` → []). */
function shadow(css, where) {
  if (css === 'none') return []
  return splitTopLevel(css, ',').map((layer) => {
    const parts = splitTopLevel(layer, ' ').filter(Boolean)
    const inset = parts[0] === 'inset'
    if (inset) parts.shift()
    const lengths = []
    while (parts.length > 1 && /^-?\d*\.?\d+(px|rem)?$/.test(parts[0])) lengths.push(parts.shift())
    if (parts.length !== 1 || lengths.length < 2 || lengths.length > 4) {
      throw new Error(`${where}: unsupported shadow layer "${layer}"`)
    }
    const [offsetX, offsetY, blurRadius = 0, spreadDistance = 0] = lengths.map((l) => px(l, where))
    return { offsetX, offsetY, blurRadius, spreadDistance, color: hex(parts[0], where), inset }
  })
}

/** font-family list → family names, quotes removed. */
function fontStack(css) {
  return splitTopLevel(css, ',').map((f) => f.replace(/^['"]|['"]$/g, ''))
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

// ── Export ──────────────────────────────────────────────────────────────────

const decls = collectDeclarations()

// The colour set is what globals.css registers in `@theme` (every theme has it).
const colorNames = [
  ...new Set(decls.filter((d) => d.layer === 1 && d.name.startsWith('--color-')).map((d) => d.name)),
]

const themes = {}
const wcagRows = []
let failed = false

for (const [theme, classes] of Object.entries(THEMES)) {
  const props = cascade(decls, classes)
  const value = (name) => resolve(props, name, theme)

  const colors = {}
  for (const name of colorNames) colors[camel(name.slice('--color-'.length))] = hex(value(name), `${theme} ${name}`)
  const desktop = { ...colors }

  const overrides = MOBILE_OVERRIDES[theme] ?? {}
  for (const [key, source] of Object.entries(overrides)) {
    if (!(key in colors)) throw new Error(`${theme}: override of unknown colour "${key}"`)
    colors[key] = hex(value(source), `${theme} ${source}`)
  }

  for (const [fg, bg] of WCAG_PAIRS) {
    const desktopRatio = wcagContrast(opaque(desktop[fg], theme, fg), opaque(desktop[bg], theme, bg))
    const ratio = wcagContrast(opaque(colors[fg], theme, fg), opaque(colors[bg], theme, bg))
    const overridden = desktop[fg] !== colors[fg] || desktop[bg] !== colors[bg]
    let status = ratio >= WCAG_MIN ? 'ok' : 'FAIL'
    if (overridden && desktopRatio >= WCAG_MIN) status = 'STALE OVERRIDE'
    if (status !== 'ok') failed = true
    wcagRows.push({ theme, pair: `${fg} on ${bg}`, desktopRatio, ratio, overridden, status })
  }

  const radii = {}
  for (const [level, variantClass] of Object.entries(CORNER_RADII)) {
    const variantProps = cascade(decls, variantClass ? [...classes, variantClass] : classes)
    radii[level] = {}
    for (const [key, name] of Object.entries(RADII)) {
      radii[level][key] = px(resolve(variantProps, name, `${theme}.${level}`), `${theme} ${name}`)
    }
  }

  const elevation = {}
  for (const [key, name] of Object.entries(ELEVATION)) elevation[key] = shadow(value(name), `${theme} ${name}`)

  const fonts = {}
  for (const [key, name] of Object.entries(FONTS)) fonts[key] = fontStack(value(name))

  themes[theme] = { colors, radii, elevation, fonts }
}

function opaque(color, theme, key) {
  if (color.length !== 7) throw new Error(`${theme}: WCAG pair colour ${key} is not opaque (${color})`)
  return color
}

const json = `${JSON.stringify(
  {
    $comment:
      'Generated by mobile/scripts/export-design-tokens.mjs from src/styles/globals.css (`pnpm tokens:export`). Do not edit.',
    mobileOverrides: MOBILE_OVERRIDES,
    themes,
  },
  null,
  2,
)}\n`

printWcag()

const outPath = fileURLToPath(OUT)
if (check) {
  let current = null
  try {
    current = readFileSync(outPath, 'utf8')
  } catch {
    // Missing file is stale.
  }
  if (current !== json) {
    console.error(`${outPath} is stale; run \`pnpm tokens:export\``)
    process.exit(1)
  }
} else {
  writeFileSync(outPath, json)
  console.log(`wrote ${outPath} (${Object.keys(themes).length} themes)`)
}
if (failed) {
  console.error(`WCAG: a declared pair is below ${WCAG_MIN}:1 or an override is no longer needed`)
  process.exit(1)
}

function printWcag() {
  const rows = wcagRows.map((r) => [
    r.theme,
    r.pair,
    r.desktopRatio.toFixed(2),
    r.overridden ? r.ratio.toFixed(2) : '',
    r.status,
  ])
  const head = ['theme', 'pair', 'desktop', 'mobile override', 'status']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '))
}
