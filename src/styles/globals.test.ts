import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_ACCENT_HEX } from '../lib/accentPresets'
import { getContrastRatio } from '../lib/themeColors'

/**
 * Token presence tests for the Memlore design system (post-redesign).
 *
 * We parse globals.css as text (not via getComputedStyle) because jsdom
 * doesn't execute the Tailwind v4 `@utility` block and doesn't resolve
 * cascaded custom properties the way a real browser does. String-matching
 * the source is enough to catch accidental token removal during migration.
 */

/**
 * Tokens written inline by `applyAccent()`. A stylesheet value for any of
 * these is dead under Clean (inline styles win), so coverage parity with
 * the Signature `.dark` block does not require them. Adding a name here is
 * a deliberate exception — do not grow this list to silence a missing
 * Clean override.
 */
const CLEAN_INLINE_ONLY_TOKENS = [
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-soft',
  '--color-accent-text',
  '--color-accent-fill',
  '--color-editor-selection',
  '--color-focus-ring',
  '--accent-rgb',
  '--grad-primary',
  '--grad-accent-fill',
  '--grad-accent-soft',
  '--shadow-primary-glow',
  '--selected-border',
] as const

const CLEAN_INLINE_ONLY_TOKEN_SET: ReadonlySet<string> = new Set(CLEAN_INLINE_ONLY_TOKENS)

/** Body of a `{ … }` rule, given the source immediately after the opening `{`. */
function firstRuleBody(afterOpenBrace: string): string {
  let depth = 1
  for (let i = 0; i < afterOpenBrace.length; i++) {
    const ch = afterOpenBrace[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return afterOpenBrace.slice(0, i)
    }
  }
  return afterOpenBrace
}

function extractTopLevelRules(source: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  let i = 0
  let selectorStart = 0
  while (i < source.length) {
    if (source[i] === '{') {
      const selector = source.slice(selectorStart, i).trim()
      const body = firstRuleBody(source.slice(i + 1))
      rules.push({ selector, body })
      i += 1 + body.length + 1
      selectorStart = i
      continue
    }
    i += 1
  }
  return rules
}

function selectorParts(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function isCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every(
    (part) => part === ':root.ds-clean' || part === ':root.dark.ds-clean',
  )
}

function isDarkCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.dark.ds-clean')
}

function isLightCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.ds-clean')
}

function isClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every(
    (part) => part === ':root.ds-clay' || part === ':root.dark.ds-clay',
  )
}

function isDarkClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.dark.ds-clay')
}

function isLightClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.ds-clay')
}

function isLumenTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === '.dark.surface-lumen')
}

/** Color / status / border / content-grad — the set `:root.dark.ds-clean` must own. */
function isCleanPaintToken(name: string): boolean {
  return name.startsWith('--color-') || name.startsWith('--content-grad-')
}

function mentionsDsClean(selector: string): boolean {
  return selector.includes('ds-clean')
}

function mentionsDsClay(selector: string): boolean {
  return selector.includes('ds-clay')
}

function mentionsSurfaceLumen(selector: string): boolean {
  return selector.includes('surface-lumen')
}

function customPropertyNames(block: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    const name = match[1]
    if (name !== undefined && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function lastMatchIndex(source: string, re: RegExp): number {
  let last = -1
  for (const match of source.matchAll(new RegExp(re, 'g'))) {
    if (match.index !== undefined) last = match.index
  }
  return last
}

// ---------------------------------------------------------------------------
// WCAG AA helpers (test-local). No culori/colorjs in the app; OKLab matrices
// from Björn Ottosson / CSS Color 4. Achromatic oklch(L 0 0) has Y = L³.
// ---------------------------------------------------------------------------

type SurfaceId =
  | 'signature-light'
  | 'signature-dark'
  | 'signature-soft'
  | 'clean-light'
  | 'clean-dark'
  | 'lumen-dark'
  | 'clay-light'
  | 'clay-dark'

type Srgb = { r: number; g: number; b: number; a: number }

const WCAG_AA_MIN = 4.5

const FG_ROLES = ['--color-fg', '--color-fg-secondary', '--color-fg-muted'] as const
const SURFACE_ROLES = [
  '--color-app',
  '--color-panel-1',
  '--color-panel-2',
  '--color-panel-3',
  '--color-selected-tab',
  '--entry-card-hover-bg',
  '--color-elevated',
  '--color-surface-hi',
  '--color-chrome',
  // Settings rows hover the row container and carry `text-fg-muted` sub-copy
  // inside it (RemindersPanel, DeviceList, JournalsSettings, LocationSettings,
  // TemplatesSettings, ProvidersTab), so the hover fill is a text surface on
  // every skin — not a Clay-only one.
  '--color-surface-row-hover',
  '--nav-active-bg',
] as const
/** Clay-only text surfaces. `--color-surface-control` stays here: its only
 *  consumer is Button secondary, which labels with `text-fg` (see the Signature
 *  audit, finding 9) — Soft's #3f3f3f track would fail with muted ink. */
const CLAY_EXTRA_SURFACE_ROLES = ['--nav-rail-active-bg', '--color-surface-control'] as const
const STATUS_TEXT_ROLES = [
  '--color-danger-text',
  '--color-success-text',
  '--color-warning-text',
  '--color-info-text',
  '--color-empty-text',
] as const
// Status copy also lands on raised fills and on hovered settings rows, not
// just the flat page and card.
const STATUS_SURFACES = ['--color-app', '--color-elevated', '--color-surface-row-hover'] as const

const SHIPPING_SURFACES: { id: SurfaceId; label: string }[] = [
  { id: 'signature-light', label: 'Signature light (@theme)' },
  { id: 'signature-dark', label: 'Signature .dark' },
  { id: 'signature-soft', label: 'Signature .dark.surface-soft' },
  { id: 'clean-light', label: 'Clean light (:root.ds-clean)' },
  { id: 'clean-dark', label: 'Clean dark (:root.dark.ds-clean)' },
  { id: 'lumen-dark', label: 'Signature .dark.surface-lumen' },
  { id: 'clay-light', label: 'Clay light (:root.ds-clay)' },
  { id: 'clay-dark', label: 'Clay dark (:root.dark.ds-clay)' },
]

function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) map.set(name, value.trim())
  }
  return map
}

function cascadeTokenMaps(...blocks: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    for (const [name, value] of parseDeclarations(block)) map.set(name, value)
  }
  return map
}

function resolveVars(
  value: string,
  tokens: Map<string, string>,
  seen: Set<string> = new Set(),
): string {
  return value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_full, name: string) => {
    if (seen.has(name)) throw new Error(`custom property cycle at ${name}`)
    // Clean blocks omit --color-accent (applyAccent writes it inline). The
    // stylesheet fallback is @theme / .dark Sky — the default preset.
    const next = tokens.get(name) ?? (name === '--color-accent' ? DEFAULT_ACCENT_HEX : undefined)
    if (next === undefined) throw new Error(`unresolved custom property ${name}`)
    const nextSeen = new Set(seen)
    nextSeen.add(name)
    return resolveVars(next, tokens, nextSeen)
  })
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgbChannel(c: number): number {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function parseHexColor(hex: string): Srgb {
  let h = hex.trim().slice(1)
  if (h.length === 3 || h.length === 4) {
    h = [...h].map((ch) => ch + ch).join('')
  }
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`unsupported hex color: ${hex}`)
  }
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1
  if (![r, g, b, a].every((n) => Number.isFinite(n))) {
    throw new Error(`invalid hex color: ${hex}`)
  }
  return { r, g, b, a }
}

function oklabToLinearSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

function linearSrgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

function oklabToSrgb(L: number, a: number, b: number, alpha: number): Srgb {
  const lin = oklabToLinearSrgb(L, a, b)
  return {
    r: linearToSrgbChannel(lin.r),
    g: linearToSrgbChannel(lin.g),
    b: linearToSrgbChannel(lin.b),
    a: alpha,
  }
}

function srgbToOklab(color: Srgb): { L: number; a: number; b: number } {
  return linearSrgbToOklab(
    srgbChannelToLinear(color.r),
    srgbChannelToLinear(color.g),
    srgbChannelToLinear(color.b),
  )
}

function parseOklch(value: string): Srgb {
  const match = value
    .trim()
    .match(
      /^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?(?:\s*\/\s*([0-9.]+)(%?))?\s*\)$/i,
    )
  if (!match) throw new Error(`unsupported oklch() color: ${value}`)
  const Lraw = Number(match[1])
  const C = Number(match[3])
  const H = Number(match[4])
  const L = match[2] === '%' ? Lraw / 100 : Lraw
  let alpha = 1
  if (match[5] !== undefined) {
    const aRaw = Number(match[5])
    alpha = match[6] === '%' ? aRaw / 100 : aRaw
  }
  if (![L, C, H, alpha].every((n) => Number.isFinite(n))) {
    throw new Error(`invalid oklch() color: ${value}`)
  }
  const hue = (H * Math.PI) / 180
  return oklabToSrgb(L, C * Math.cos(hue), C * Math.sin(hue), alpha)
}

function splitTopLevelArgs(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(inner.slice(start).trim())
  return parts.filter((part) => part.length > 0)
}

function parseMixStop(stop: string): { color: Srgb; p: number | null } {
  const match = stop.match(/^(.*?)\s+([0-9.]+)%$/)
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { color: parseCssColor(match[1].trim()), p: Number(match[2]) / 100 }
  }
  return { color: parseCssColor(stop), p: null }
}

function parseColorMix(value: string): Srgb {
  const match = value.trim().match(/^color-mix\(\s*in\s+oklab\s*,\s*([\s\S]+)\)$/i)
  if (!match || match[1] === undefined) {
    throw new Error(`unsupported color-mix() (need in oklab): ${value}`)
  }
  const stops = splitTopLevelArgs(match[1]).map(parseMixStop)
  if (stops.length !== 2) {
    throw new Error(`color-mix() needs two stops: ${value}`)
  }
  const a = stops[0]
  const b = stops[1]
  if (a === undefined || b === undefined) {
    throw new Error(`color-mix() needs two stops: ${value}`)
  }
  let p = 0.5
  if (a.p !== null && b.p !== null) {
    const sum = a.p + b.p
    p = sum === 0 ? 0.5 : a.p / sum
  } else if (a.p !== null) p = a.p
  else if (b.p !== null) p = 1 - b.p
  const labA = srgbToOklab(a.color)
  const labB = srgbToOklab(b.color)
  const L = labA.L * p + labB.L * (1 - p)
  const ax = labA.a * p + labB.a * (1 - p)
  const bx = labA.b * p + labB.b * (1 - p)
  const alpha = a.color.a * p + b.color.a * (1 - p)
  return oklabToSrgb(L, ax, bx, alpha)
}

/**
 * `oklch(from <color> <L> c h)` — the relative form Clay uses for its button
 * slabs (`--cta-face`, `--danger-face`, and their lips). Only lightness is
 * pinned; `c` and `h` are inherited, and since OKLCH's chroma/hue are just
 * OKLab's `a`/`b` in polar form, inheriting both means `a` and `b` pass
 * through untouched. So this is a pure lightness swap on the base colour.
 *
 * Caveat: `oklabToSrgb` clamps per channel, while browsers gamut-map by
 * reducing chroma. The two agree closely at the lightness these tokens pin
 * (spot-checked against the live app: --danger-face reads 5.91:1 there and
 * 5.914:1 here on Clay dark; --cta-face 5.39 vs 5.44), but a token
 * that lands far outside sRGB would read slightly more saturated in this
 * harness than on screen.
 */
function parseRelativeOklch(value: string): Srgb {
  const match = value.trim().match(/^oklch\(\s*from\s+(.+?)\s+([0-9.]+)(%?)\s+c\s+h\s*\)$/i)
  if (!match) throw new Error(`unsupported relative oklch() color: ${value}`)
  const base = parseCssColor(match[1])
  const Lraw = Number(match[2])
  const L = match[3] === '%' ? Lraw / 100 : Lraw
  if (!Number.isFinite(L)) throw new Error(`invalid relative oklch() color: ${value}`)
  const lab = srgbToOklab(base)
  return oklabToSrgb(L, lab.a, lab.b, base.a)
}

function parseCssColor(value: string): Srgb {
  const v = value.trim()
  if (v.startsWith('#')) return parseHexColor(v)
  if (/^oklch\(\s*from\s/i.test(v)) return parseRelativeOklch(v)
  if (/^oklch\(/i.test(v)) return parseOklch(v)
  if (/^color-mix\(/i.test(v)) return parseColorMix(v)
  throw new Error(`unsupported color value: ${value}`)
}

function relativeLuminance(color: Srgb): number {
  return (
    0.2126 * srgbChannelToLinear(color.r) +
    0.7152 * srgbChannelToLinear(color.g) +
    0.0722 * srgbChannelToLinear(color.b)
  )
}

function wcagContrastRatio(a: Srgb, b: Srgb): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function compositeOver(fg: Srgb, bg: Srgb): Srgb {
  if (fg.a >= 1 - 1e-9) return { r: fg.r, g: fg.g, b: fg.b, a: 1 }
  const t = 1 - fg.a
  return {
    r: fg.r * fg.a + bg.r * t,
    g: fg.g * fg.a + bg.g * t,
    b: fg.b * fg.a + bg.b * t,
    a: 1,
  }
}

function tokenColor(tokens: Map<string, string>, name: string): Srgb {
  const raw = tokens.get(name)
  if (raw === undefined) {
    if (name === '--color-accent') return parseCssColor(DEFAULT_ACCENT_HEX)
    throw new Error(`missing token ${name}`)
  }
  const color = parseCssColor(resolveVars(raw, tokens))
  if (color.a >= 1 - 1e-9) return color
  if (name === '--color-app') return compositeOver(color, { r: 0, g: 0, b: 0, a: 1 })
  return compositeOver(color, tokenColor(tokens, '--color-app'))
}

function contrastOf(tokens: Map<string, string>, fgName: string, bgName: string): number {
  return wcagContrastRatio(tokenColor(tokens, fgName), tokenColor(tokens, bgName))
}

let css: string
/**
 * `css` with `/* … *\/` comments stripped.
 *
 * Needed for *negative* assertions ("this selector must not exist"): the file
 * documents other design systems in prose, so a bare regex over the raw source
 * matches selector-shaped text inside comments and fails on a file that is
 * actually correct. Positive assertions keep using `css` — a token mentioned
 * only in a comment would be a test bug, not something to hide.
 */
let cssCode: string
let darkBlock: string
let themeBlock: string
/** Signature `.dark { … }` body only — not the remainder of the file after the split. */
let signatureDarkBody: string
/** Signature `.dark.surface-soft { … }` body — lifted charcoal overlay. */
let signatureSoftBody: string
/** Combined bodies of exact `:root.ds-clean` / `:root.dark.ds-clean` token blocks. */
let cleanTokenBodies: string
/** Combined bodies of exact `:root.ds-clean` token blocks only (not the dark union). */
let cleanLightTokenBodies: string
/** Combined bodies of exact `:root.dark.ds-clean` token blocks only (not the light union). */
let cleanDarkTokenBodies: string
/** Every Clean rule body, including descendants (`:root.ds-clean .x`). */
let cleanRuleBodies: string
/** Combined bodies of exact `:root.ds-clay` / `:root.dark.ds-clay` token blocks. */
let clayTokenBodies: string
/** Combined bodies of exact `:root.ds-clay` token blocks only (not the dark union). */
let clayLightTokenBodies: string
/** Combined bodies of exact `:root.dark.ds-clay` token blocks only (not the light union). */
let clayDarkTokenBodies: string
/** Every Clay rule body, including descendants (`:root.ds-clay .x`). */
let clayRuleBodies: string
/** Combined bodies of exact `.dark.surface-lumen` token blocks (paint + radius/elev). */
let lumenTokenBodies: string
/** Alias of `lumenTokenBodies` — there is no shared non-dark Lumen block. */
let lumenDarkTokenBodies: string
/** Every Lumen rule body, including descendants (`.dark.surface-lumen .x`). */
let lumenRuleBodies: string
/** Cascaded custom properties per shipping surface, later blocks win. */
let tokensBySurface: Record<SurfaceId, Map<string, string>>

beforeAll(() => {
  css = readFileSync(resolve(__dirname, 'globals.css'), 'utf8')
  cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Dark overrides live in the .dark { } block
  const parts = css.split(/\.dark\s*\{/)
  darkBlock = parts[1] ?? ''
  themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  // `:root.dark.ds-clean {` does not match `/\.dark\s*\{/` — keep that split
  // intact for Signature assertions, then take only the first balanced body.
  // The split consumes the `{`, so the remainder already starts inside the body.
  signatureDarkBody = firstRuleBody(cssCode.split(/\.dark\s*\{/)[1] ?? '')
  signatureSoftBody = firstRuleBody(cssCode.split(/\.dark\.surface-soft\s*\{/)[1] ?? '')
  const rules = extractTopLevelRules(cssCode)
  cleanTokenBodies = rules
    .filter((rule) => isCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanLightTokenBodies = rules
    .filter((rule) => isLightCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanDarkTokenBodies = rules
    .filter((rule) => isDarkCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanRuleBodies = rules
    .filter((rule) => mentionsDsClean(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayTokenBodies = rules
    .filter((rule) => isClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayLightTokenBodies = rules
    .filter((rule) => isLightClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayDarkTokenBodies = rules
    .filter((rule) => isDarkClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayRuleBodies = rules
    .filter((rule) => mentionsDsClay(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  lumenTokenBodies = rules
    .filter((rule) => isLumenTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  lumenDarkTokenBodies = lumenTokenBodies
  lumenRuleBodies = rules
    .filter((rule) => mentionsSurfaceLumen(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  tokensBySurface = {
    'signature-light': cascadeTokenMaps(themeBlock),
    'signature-dark': cascadeTokenMaps(themeBlock, signatureDarkBody),
    'signature-soft': cascadeTokenMaps(themeBlock, signatureDarkBody, signatureSoftBody),
    'clean-light': cascadeTokenMaps(themeBlock, cleanLightTokenBodies),
    'clean-dark': cascadeTokenMaps(
      themeBlock,
      signatureDarkBody,
      cleanLightTokenBodies,
      cleanDarkTokenBodies,
    ),
    'lumen-dark': cascadeTokenMaps(themeBlock, signatureDarkBody, lumenDarkTokenBodies),
    'clay-light': cascadeTokenMaps(themeBlock, clayLightTokenBodies),
    'clay-dark': cascadeTokenMaps(
      themeBlock,
      signatureDarkBody,
      clayLightTokenBodies,
      clayDarkTokenBodies,
    ),
  }
})

describe('Semantic OKLCH tokens — registered in @theme', () => {
  it.each([
    '--color-app',
    '--color-panel-1',
    '--color-panel-2',
    '--color-panel-3',
    '--color-elevated',
    '--color-chrome',
    '--color-fg',
    '--color-fg-secondary',
    '--color-fg-muted',
    '--color-fg-inverse',
    '--color-surface-hi',
    '--color-border-subtle',
    '--color-border-default',
    '--color-border-strong',
    '--color-accent',
    '--color-accent-hover',
    '--color-accent-soft',
    '--color-accent-text',
    '--color-focus-ring',
    '--color-danger',
    '--color-success',
    '--color-warning',
    '--color-info',
    '--color-empty',
    '--color-warning-bg',
    '--color-warning-border',
    '--color-warning-fg',
    '--color-danger-bg',
    '--color-danger-border',
    '--color-danger-fg',
  ])('@theme defines %s', (token) => {
    expect(themeBlock).toContain(token)
  })
})

describe('Dark mode redefines all semantic tokens', () => {
  it.each([
    '--color-app',
    '--color-panel-1',
    '--color-panel-2',
    '--color-panel-3',
    '--color-elevated',
    '--color-chrome',
    '--color-fg',
    '--color-fg-secondary',
    '--color-fg-muted',
    '--color-fg-inverse',
    '--color-surface-hi',
    '--color-border-subtle',
    '--color-border-default',
    '--color-border-strong',
    '--color-accent',
    '--color-accent-soft',
    '--color-accent-text',
    '--color-focus-ring',
  ])('dark block redefines %s', (token) => {
    expect(darkBlock).toContain(token)
  })
})

describe('Typography token overrides', () => {
  it('floors --text-lg at --text-base so the ladder cannot invert', () => {
    // Clay at Interface size 1.1 puts base at 18.66px, above the unscaled
    // 18px heading step — the `max()` keeps them equal instead of inverted.
    expect(css).toMatch(/--text-lg:\s*max\(1\.125rem,\s*var\(--text-base\)\);/)
  })
})

describe('Tailwind v4 utilities', () => {
  it('Clay CTA label: the primary button is white ink, other accent fills keep the accent ink', () => {
    expect(css).not.toMatch(/:root\.ds-clay\s+\.gradient-primary\s*\{[^}]*color:/)
    // Every accent slab that carries a label now uses the CTA face + ink; the
    // dark accent-ink rule is left only for the generic .gradient-primary fill.
    expect(css).toMatch(
      /:root\.dark\.ds-clay\s+\.gradient-primary:not\(button\[data-variant='primary'\]\)\s*\{[^}]*color:\s*var\(--color-accent-ink\)/,
    )
    expect(css).toMatch(
      /:root\.ds-clay\s+button\[data-variant='primary'\]\s*\{[^}]*color:\s*var\(--cta-ink\)/,
    )
    expect(clayTokenBodies).toMatch(/--cta-ink:\s*#ffffff/)
  })

  it('Clay slabs carry no negative-offset inner shade (it left a light hairline)', () => {
    expect(clayTokenBodies).not.toMatch(/inset 0 -\d+px/)
    expect(css).not.toMatch(
      /:root\.ds-clay\s+button\[data-variant='primary'\]\s*\{[^}]*box-shadow:[^;]*inset/,
    )
  })
})

describe('Fonts — self-hosted, no network (offline regression guard)', () => {
  // The app ships `vi`. Every face that can render user content (entry titles
  // via --font-title, UI via --font-sans, code via --font-mono) must carry the
  // Vietnamese subset, or a Vietnamese string falls back to a system face
  // mid-word. Asserted against the installed packages, not the stylesheet.
  it.each([
    ['@fontsource-variable/fraunces/index.css', 'Fraunces — --font-title, entry titles'],
    ['@fontsource-variable/geist/index.css', 'Geist — --font-sans on Signature/Clean'],
    ['@fontsource-variable/baloo-2/index.css', 'Baloo 2 — --font-sans on Clay'],
    ['@fontsource-variable/geist-mono/index.css', 'Geist Mono — --font-mono'],
  ])('%s ships a vietnamese @font-face (%s)', (spec) => {
    const file = readFileSync(require.resolve(spec), 'utf8')
    expect(file).toMatch(/unicode-range:[^;]*U\+1EA0-1EF9/)
  })

  it('does NOT reference Google Fonts (or any external font URL) — fonts are bundled offline', () => {
    // The whole point: no runtime CDN request for typography. Fonts are
    // self-hosted via @fontsource packages imported in src/main.tsx.
    expect(css).not.toContain('fonts.googleapis.com')
    expect(css).not.toContain('fonts.gstatic.com')
    expect(css).not.toMatch(/@import\s+url\(['"]https?:\/\//)
  })
})

describe('Titlebar and graphite backdrop (Phase 3 — blobs removed)', () => {
  it('stops all animation under prefers-reduced-motion', () => {
    const reducedBlock = css.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\n\}/,
    )
    expect(reducedBlock).not.toBeNull()
    // General kill-switch must be present
    expect(reducedBlock![0]).toMatch(/\*\s*\{[^}]*animation:\s*none/)
  })
})

describe('Accessibility', () => {
  it('defines a JS-driven .reduce-motion class as a parallel path', () => {
    expect(css).toMatch(/\.reduce-motion\s*\*\s*\{/)
  })

  // Focus rings are deliberately removed app-wide (desktop feel — the WebView
  // Tab ring reads as browser chrome). This guard protects the REMOVAL: a
  // reviewer re-adding a ring "for a11y" breaks this test on purpose.
  it('paints no focus ring anywhere', () => {
    expect(css).toMatch(/(?:^|\n):focus-visible\s*\{[^}]*outline:\s*none/)
    expect(css).not.toMatch(/(?:outline|box-shadow):[^;]*var\(--color-focus-ring\)/)
  })
})

describe('Clean design system — :root.ds-clean / :root.dark.ds-clean', () => {
  it('redefines every Signature .dark token except the inline-only allowlist', () => {
    const darkTokens = customPropertyNames(signatureDarkBody)
    expect(darkTokens.length).toBeGreaterThan(40)

    const allowlistNotInDark = CLEAN_INLINE_ONLY_TOKENS.filter(
      (token) => !darkTokens.includes(token),
    )
    expect(allowlistNotInDark).toEqual([])

    const missing = darkTokens.filter(
      (name) => !CLEAN_INLINE_ONLY_TOKEN_SET.has(name) && !cleanTokenBodies.includes(`${name}:`),
    )
    expect(missing).toEqual([])
  })

  // Union-parity can pass on `:root.ds-clean` alone — that light block already
  // names every `.dark` color token. html.dark.ds-clean would then paint light
  // neutrals: `:root.ds-clean` is (0,2,0) and beats `.dark` (0,1,0).
  it('redefines color, status, border, and content-grad tokens on :root.dark.ds-clean itself', () => {
    expect(cleanDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(cleanDarkTokenBodies).toContain('--color-app:')

    const paintTokens = customPropertyNames(signatureDarkBody).filter(
      (name) => !CLEAN_INLINE_ONLY_TOKEN_SET.has(name) && isCleanPaintToken(name),
    )
    expect(paintTokens.length).toBeGreaterThan(0)

    const missing = paintTokens.filter((name) => !cleanDarkTokenBodies.includes(`${name}:`))
    expect(missing).toEqual([])
  })

  it('does not override --font-title so titles stay Fraunces Variable', () => {
    expect(cleanTokenBodies).not.toContain('--font-title:')
  })

  it('every --color-* referenced by a Clean value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of cleanRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('does not use a bare .ds-clean or .dark.ds-clean selector', () => {
    const illegal: string[] = []
    for (const match of cssCode.matchAll(/\.ds-clean(?![a-z0-9-])/g)) {
      const prefix = cssCode.slice(0, match.index)
      if (!prefix.endsWith(':root') && !prefix.endsWith(':root.dark')) {
        const from = Math.max(0, match.index - 24)
        illegal.push(cssCode.slice(from, match.index + '.ds-clean'.length).trim())
      }
    }
    expect(illegal).toEqual([])
  })

  it('places the first :root.ds-clean block after the last .dark.surface-soft block', () => {
    const lastSoft = lastMatchIndex(cssCode, /\.dark\.surface-soft\s*\{/)
    const firstClean = cssCode.search(/:root\.ds-clean\s*\{/)
    expect(lastSoft).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(lastSoft)
  })
})

describe('Signature Lumen surface — .dark.surface-lumen', () => {
  it('defines a dark paint block with --color-app', () => {
    expect(lumenDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(lumenDarkTokenBodies).toContain('--color-app:')
  })

  it('omits --color-accent so first paint inherits Signature .dark until applyAccent', () => {
    expect(lumenDarkTokenBodies).not.toContain('--color-accent:')
    expect(lumenDarkTokenBodies).not.toContain('--color-accent-fill:')
  })

  it('does not override --font-title or --button-radius', () => {
    expect(lumenTokenBodies).not.toContain('--font-title:')
    expect(lumenTokenBodies).not.toContain('--button-radius:')
  })

  it('every --color-* referenced by a Lumen value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of lumenRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('has zero ds-lumen identifiers', () => {
    expect(css).not.toContain('ds-lumen')
  })

  it('does not declare @custom-variant surface-lumen or a light Lumen block', () => {
    expect(cssCode).not.toMatch(/@custom-variant\s+surface-lumen/)
    const lumenSelectors = extractTopLevelRules(cssCode)
      .filter((rule) => mentionsSurfaceLumen(rule.selector))
      .map((rule) => rule.selector)
    expect(lumenSelectors.length).toBeGreaterThan(0)
    expect(lumenSelectors.every((selector) => selector.startsWith('.dark.surface-lumen'))).toBe(
      true,
    )
  })

  it('places the first .dark.surface-lumen block after the last .dark.surface-soft and before the first Clean block', () => {
    const lastSoft = lastMatchIndex(cssCode, /\.dark\.surface-soft\s*\{/)
    const firstLumen = cssCode.search(/\.dark\.surface-lumen\s*\{/)
    const firstClean = cssCode.search(/:root\.ds-clean\s*\{/)
    expect(lastSoft).toBeGreaterThan(-1)
    expect(firstLumen).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(-1)
    expect(firstLumen).toBeGreaterThan(lastSoft)
    expect(firstClean).toBeGreaterThan(firstLumen)
  })
})

describe('Clay design system — :root.ds-clay / :root.dark.ds-clay', () => {
  it('defines the same paint token set Clean defines on light and dark', () => {
    expect(clayLightTokenBodies.trim().length).toBeGreaterThan(0)
    expect(clayDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(clayTokenBodies).toContain('--color-app:')

    const cleanLightPaint = customPropertyNames(cleanLightTokenBodies).filter(isCleanPaintToken)
    const cleanDarkPaint = customPropertyNames(cleanDarkTokenBodies).filter(isCleanPaintToken)
    expect(cleanLightPaint.length).toBeGreaterThan(0)
    expect(cleanDarkPaint.length).toBeGreaterThan(0)

    const missingLight = cleanLightPaint.filter(
      (name) => !clayLightTokenBodies.includes(`${name}:`),
    )
    const missingDark = cleanDarkPaint.filter((name) => !clayDarkTokenBodies.includes(`${name}:`))
    expect(missingLight).toEqual([])
    expect(missingDark).toEqual([])
  })

  // Union-parity can pass on `:root.ds-clay` alone — that light block already
  // names these. html.dark.ds-clay would then paint light values:
  // `:root.ds-clay` is (0,2,0) and beats `.dark` (0,1,0). isCleanPaintToken
  // is color + content-grad only, so elev / nav-active / hairline / idle-bg
  // would not be caught.
  it('redefines inherit-prone tokens on :root.dark.ds-clay itself', () => {
    expect(clayDarkTokenBodies.trim().length).toBeGreaterThan(0)

    const inheritProne = [
      '--elev-1',
      '--elev-2',
      '--elev-3',
      '--elev-4',
      '--shadow-cta',
      '--shadow-cta-pressed',
      '--shadow-panel',
      '--shadow-card',
      '--shadow-control',
      '--slab-deep',
      '--shadow-toggle-on',
      '--grad-surface',
      '--nav-active-bg',
      '--nav-hover-bg',
      '--nav-rail-active-bg',
      '--nav-rail-hover-bg',
      '--hairline-strong',
      '--entry-card-idle-bg',
    ]
    const missing = inheritProne.filter((name) => !clayDarkTokenBodies.includes(`${name}:`))
    expect(missing).toEqual([])
  })

  it('does not use a bare .ds-clay or .dark.ds-clay selector', () => {
    const illegal: string[] = []
    for (const match of cssCode.matchAll(/\.ds-clay(?![a-z0-9-])/g)) {
      const prefix = cssCode.slice(0, match.index)
      if (!prefix.endsWith(':root') && !prefix.endsWith(':root.dark')) {
        const from = Math.max(0, match.index - 24)
        illegal.push(cssCode.slice(from, match.index + '.ds-clay'.length).trim())
      }
    }
    expect(illegal).toEqual([])
  })

  it('does not override --font-title so titles stay Fraunces Variable', () => {
    expect(clayTokenBodies).not.toContain('--font-title:')
  })

  it('mirrors the Clay press-physics reduced-motion rule on the JS .reduce-motion class', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\.reduce-motion\s+button\[data-variant\]:hover:not\(:disabled\),[^{]*\{[^}]*transform:\s*none/,
    )
  })

  it('every --color-* referenced by a Clay value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of clayRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })
})

/**
 * Scripted WCAG AA 4.5:1 check across the eight shipping surfaces.
 *
 * No text-role exemptions: `--color-fg-faint` used to be excused here as
 * "decorative", but every consumer was readable type and it cleared 4.5:1 on
 * none of the eight surfaces — the token is deleted, not exempted.
 * Primary CTA fill is `--color-accent-fill` on every surface.
 *
 * `--color-accent-fill` is a chroma-preserving oklch in both modes (the
 * lightest L that still clears 4.5:1 with `--color-fg-inverse`), except
 * Clay: kit hex slabs carry white labels by design direction (see
 * docs/design/DESIGN_clay.md); `--color-accent-text` is the AA net there.
 * Buttons paint `--grad-accent-fill` (two-stop sweep of that fill). Clean
 * blocks omit `--color-accent` / `--color-accent-fill` (inline from
 * applyAccent); cascade still sees `@theme` / `.dark` Sky tokens (default
 * preset). Lumen omits `--color-accent` the same way so first paint is Sky
 * until applyAccent writes the user preset. Raw Sky *chrome* accent vs
 * white is below AA and is not this pair.
 */

describe('WCAG AA 4.5:1 — eight shipping surfaces', () => {
  it('oklch(0 0 0) on oklch(1 0 0) is 21:1 (Y = L³)', () => {
    const ratio = wcagContrastRatio(parseCssColor('oklch(0 0 0)'), parseCssColor('oklch(1 0 0)'))
    expect(ratio).toBeCloseTo(21, 5)
  })

  it('hex luminance matches getContrastRatio, including 3-digit #eee', () => {
    const a = parseHexColor('#0d0d0d')
    const b = parseHexColor('#eee')
    expect(wcagContrastRatio(a, b)).toBeCloseTo(getContrastRatio('#0d0d0d', '#eeeeee'), 5)
  })

  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      FG_ROLES.flatMap((fg) => SURFACE_ROLES.map((bg) => ({ id, label, fg, bg }))),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  it.each(
    (['clay-light', 'clay-dark'] as const).flatMap((id) =>
      FG_ROLES.flatMap((fg) =>
        CLAY_EXTRA_SURFACE_ROLES.map((bg) => ({
          id,
          label:
            id === 'clay-light' ? 'Clay light (:root.ds-clay)' : 'Clay dark (:root.dark.ds-clay)',
          fg,
          bg,
        })),
      ),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      STATUS_TEXT_ROLES.flatMap((fg) => STATUS_SURFACES.map((bg) => ({ id, label, fg, bg }))),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  // Destructive Button + error copy sit on elevated / panel-1 / panel-2.
  // `--color-danger` fails AA on Soft elevated; `--color-danger-text` must
  // clear 4.5:1 on every raised surface the variant actually paints on.
  const DANGER_TEXT_SURFACES = ['--color-elevated', '--color-panel-1', '--color-panel-2'] as const
  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      DANGER_TEXT_SURFACES.map((bg) => ({ id, label, bg })),
    ),
  )('$label: --color-danger-text on $bg ≥ 4.5:1', ({ id, bg }) => {
    expect(contrastOf(tokensBySurface[id], '--color-danger-text', bg)).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  it('Clay dark --color-danger-text is lighter than --color-danger (not a no-op copy)', () => {
    const tokens = tokensBySurface['clay-dark']
    expect(tokens.get('--color-danger-text')).not.toBe(tokens.get('--color-danger'))
    const dangerY = relativeLuminance(tokenColor(tokens, '--color-danger'))
    const textY = relativeLuminance(tokenColor(tokens, '--color-danger-text'))
    expect(textY).toBeGreaterThan(dangerY)
  })

  // Clay writes --color-accent-fill inline from its own sheet (themeColors.test
  // covers it); the stylesheet fallback seen here is Signature's Sky, which
  // Clay never paints — so both Clay surfaces are excluded.
  it.each(
    SHIPPING_SURFACES.filter(
      (surface) => surface.id !== 'clay-light' && surface.id !== 'clay-dark',
    ),
  )('$label: --color-fg-inverse on --color-accent-fill ≥ 4.5:1', ({ id }) => {
    expect(
      contrastOf(tokensBySurface[id], '--color-fg-inverse', '--color-accent-fill'),
    ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  // Clean paints destructive buttons as a solid --color-danger-fill with
  // --color-fg-inverse text (shadcn `bg-destructive text-white`). Clay builds
  // its slab from --danger-face / --cta-face instead; both are asserted below.
  it.each(['clean-light', 'clean-dark'] as const)(
    '%s: --color-fg-inverse on --color-danger-fill ≥ 4.5:1',
    (id) => {
      expect(
        contrastOf(tokensBySurface[id], '--color-fg-inverse', '--color-danger-fill'),
      ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
    },
  )

  // The Clay button slabs. These are what actually paint: the destructive
  // rule stamps --cta-ink on --danger-face, primary on --cta-face. Both faces
  // pin OKLCH L to 0.52 precisely so the white label clears AA, so these are
  // the assertions that make that claim real rather than a comment.
  it.each(['clay-light', 'clay-dark'] as const)('%s: --cta-ink on --danger-face >= 4.5:1', (id) => {
    expect(contrastOf(tokensBySurface[id], '--cta-ink', '--danger-face')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  it.each(['clay-light', 'clay-dark'] as const)('%s: --cta-ink on --cta-face >= 4.5:1', (id) => {
    expect(contrastOf(tokensBySurface[id], '--cta-ink', '--cta-face')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  // Every OTHER Clay accent slab that carries a label must use the same
  // face+ink pair as the CTA button. The selected calendar day and the
  // segmented-control active radio used to stamp --color-fg-inverse on the
  // raw --grad-accent-fill, which measured 2.47–4.29:1 in light across the
  // six presets — the button fix did not reach them.
  it('paints the Clay selected calendar day with the CTA face + ink', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-cal-day\[aria-pressed='true'\]\s*\{[^}]*background:\s*var\(--cta-face\)[^}]*color:\s*var\(--cta-ink\)/,
    )
  })

  it('paints the Clay segmented thumb with the CTA face + ink', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-seg-thumb\s*\{[^}]*background:\s*var\(--cta-face\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-seg \[role='radio'\]\[aria-checked='true'\]\s*\{[^}]*color:\s*var\(--cta-ink\)/,
    )
  })

  it('leaves no Clay rule stamping --color-fg-inverse on an accent slab', () => {
    const clayFgInverse = [
      ...cssCode.matchAll(
        // lookbehind so `background-color:` (a fill, e.g. the switch knob) is
        // not mistaken for a text stamp, without needing a leading character
        /:root(?:\.dark)?\.ds-clay [^{]*\{[^}]*(?<![-\w])color:\s*var\(--color-fg-inverse\)/g,
      ),
    ]
    expect(clayFgInverse.map((m) => m[0].split('{')[0].trim())).toEqual([])
  })

  // Clay light collapses panel-3 / selected-tab / elevated / surface-hi /
  // nav-active / surface-subtle onto one fill, so a tooltip painted
  // `bg-elevated` floats over a card of the identical colour, separated only
  // by a 1.21:1 hairline. Lift it to the canvas, the one other value Clay owns.
  it('lifts the Clay tooltip off the card plane', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-tooltip\s*\{[^}]*background(?:-color)?:\s*var\(--color-app\)/,
    )
  })

  // Warning / danger boxes are solid paper (no alpha). Ink must clear AA
  // on that paper — not on the page surface — across every shipping skin.
  it.each(SHIPPING_SURFACES)(
    '$label: --color-warning-fg on --color-warning-bg ≥ 4.5:1',
    ({ id }) => {
      expect(
        contrastOf(tokensBySurface[id], '--color-warning-fg', '--color-warning-bg'),
      ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
    },
  )

  it.each(SHIPPING_SURFACES)('$label: --color-danger-fg on --color-danger-bg ≥ 4.5:1', ({ id }) => {
    expect(
      contrastOf(tokensBySurface[id], '--color-danger-fg', '--color-danger-bg'),
    ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })
})

describe('Categorical viz tokens', () => {
  const VIZ_TOKENS = [
    '--color-viz-1',
    '--color-viz-2',
    '--color-viz-3',
    '--color-viz-4',
    '--color-viz-5',
    '--color-viz-6',
  ] as const

  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) => VIZ_TOKENS.map((fg) => ({ id, label, fg }))),
  )('$label: $fg exists and ≥ 4.5:1 on --color-elevated', ({ id, fg }) => {
    expect(tokensBySurface[id].get(fg)).toBeDefined()
    expect(contrastOf(tokensBySurface[id], fg, '--color-elevated')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  it.each(
    SHIPPING_SURFACES.filter(
      (surface) => surface.id === 'clay-light' || surface.id === 'clay-dark',
    ).flatMap(({ id, label }) => VIZ_TOKENS.map((fg) => ({ id, label, fg }))),
  )('$label: $fg ≥ 4.5:1 on --color-surface-control', ({ id, fg }) => {
    expect(contrastOf(tokensBySurface[id], fg, '--color-surface-control')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })
})
