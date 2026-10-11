import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyDesignSystem } from './designSystem'
import {
  applyAccent,
  applyFont,
  applyFontContrast,
  applyFontSize,
  applySurfaceStyle,
  clampFontContrast,
  clampFontSize,
  FONT_CONTRAST_DEFAULT,
  FONT_CONTRAST_MAX,
  FONT_CONTRAST_MIN,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getContrastRatio,
  getPresetHex,
  isValidHex,
  loadCustomGoogleFont,
  setGradientEnabled,
  type AccentPreset,
  CLAY_ACCENTS,
} from './themeColors'

const NAMED_PRESETS: Exclude<AccentPreset, 'custom'>[] = [
  'orange',
  'violet',
  'rose',
  'sky',
  'emerald',
  'gray',
]
const ALL_PRESETS: AccentPreset[] = [...NAMED_PRESETS, 'custom']
const CUSTOM_HEX = '#FF0066'

function paint(preset: AccentPreset): void {
  applyAccent(preset, preset === 'custom' ? CUSTOM_HEX : null)
}

function readVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

// OKLCH → #rrggbb so getContrastRatio (hex-only) can score the built tokens.
// Matrices from Björn Ottosson / CSS Color 4 (same as globals.test.ts).
function oklchToHex(value: string): string {
  const match = value.trim().match(/^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)/i)
  if (!match || match[1] === undefined || match[3] === undefined || match[4] === undefined) {
    throw new Error(`not an oklch() value: ${value}`)
  }
  const L = match[2] === '%' ? Number(match[1]) / 100 : Number(match[1])
  const C = Number(match[3])
  const H = Number(match[4])
  const hue = (H * Math.PI) / 180
  const a = C * Math.cos(hue)
  const b = C * Math.sin(hue)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const toSrgb = (c: number) => {
    const clamped = Math.min(1, Math.max(0, c))
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  }
  const hex = (c: number) =>
    Math.round(toSrgb(c) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(lr)}${hex(lg)}${hex(lb)}`
}

/** Kit presets are hex; a custom preset is derived oklch. */
function toHex(value: string): string {
  return value.startsWith('#') ? value : oklchToHex(value)
}

describe('getContrastRatio', () => {
  it('returns 21 for black on white', () => {
    const ratio = getContrastRatio('#000000', '#FFFFFF')
    expect(ratio).toBeCloseTo(21, 0)
  })
})

describe('isValidHex', () => {
  it('accepts valid 6-digit hex', () => {
    expect(isValidHex('#8b5cf6')).toBe(true)
    expect(isValidHex('#FF0066')).toBe(true)
    expect(isValidHex('#000000')).toBe(true)
  })

  it('rejects invalid hex', () => {
    expect(isValidHex('8b5cf6')).toBe(false)
    expect(isValidHex('#fff')).toBe(false)
    expect(isValidHex('#gggggg')).toBe(false)
    expect(isValidHex('')).toBe(false)
  })
})

describe('getPresetHex', () => {
  it('falls back to the sky default for a removed/unknown preset id', () => {
    // A persisted 'amber' (removed from the union) cast from storage without
    // validation must not throw — it falls back to the default brand accent,
    // mirroring applyAccent / resolveHue / getChartAccentColors.
    expect(getPresetHex('amber' as AccentPreset)).toBe('#0ea5e9')
  })
})

describe('applyAccent', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove('dark')
  })

  it('falls back to the sky default for a removed preset id (legacy persisted value)', () => {
    // A persisted 'amber' from an earlier build is read from storage and cast
    // to AccentPreset without validation; applyAccent must fall back to sky
    // rather than throw or write undefined tokens.
    applyAccent('amber' as AccentPreset, null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('230')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('230')
  })

  it('retunes --surface-hue for a custom hex and falls back on a bad hex', () => {
    applyAccent('custom', '#FF0066')
    const hue = document.documentElement.style.getPropertyValue('--surface-hue')
    expect(hue).toBeTruthy()
    expect(hue).not.toBe('NaN')
    // Malformed hex → hexToHue returns NaN → defensive fallback to sky hue 230.
    applyAccent('custom', 'not-a-hex')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('230')
  })
})

// Clean vs Signature paint contract (Phase 2 Tasks 2–4). Inline glow/gradient
// cannot be overridden by CSS — these assertions lock the applier so a later
// refactor of themeColors.ts cannot silently reintroduce gradients in Clean.
describe('applyAccent — Clean vs Signature paint', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  it('emits a flat fill and no glow under Clean', () => {
    applyDesignSystem('clean')
    applyAccent('orange', null)
    const root = document.documentElement
    const glow = root.style.getPropertyValue('--shadow-primary-glow').trim()
    const grad = root.style.getPropertyValue('--grad-primary')
    expect(glow).toBe('none')
    expect(grad).not.toContain('gradient')
    expect(root.style.getPropertyValue('--grad-accent-fill')).not.toContain('gradient')
    expect(root.style.getPropertyValue('--grad-accent-fill')).toBe(
      root.style.getPropertyValue('--color-accent-fill'),
    )
    expect(getComputedStyle(root).getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    expect(getComputedStyle(root).getPropertyValue('--grad-primary')).not.toContain('gradient')
  })

  it('Clean --grad-primary is flat for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).not.toContain('gradient')
    }
  })

  it('Clean --shadow-primary-glow is none for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    }
  })

  it('Clean --surface-chroma-scale is 0 for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--surface-chroma-scale')).toBe('0')
    }
  })

  it('Clean --grad-accent-soft is flat for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-accent-soft')).not.toContain('gradient')
    }
  })

  it('Signature --grad-primary is linear-gradient for every preset', () => {
    applyDesignSystem('signature')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).toContain('linear-gradient')
    }
  })

  it('Signature --grad-primary is a solid fill when gradients are disabled', () => {
    applyDesignSystem('signature')
    setGradientEnabled(false)
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).not.toContain('gradient')
    }
  })

  // Orange's glow is rgb(); oklch presets (including gray) use oklch() halos.
  // Assert the actual Signature contract — do not force /rgb(/ on gray.
  it('Signature --shadow-primary-glow is a glow for every preset', () => {
    applyDesignSystem('signature')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const glow = root.style.getPropertyValue('--shadow-primary-glow').trim()
      expect(glow).not.toBe('none')
      expect(glow).toMatch(/rgb\(|oklch\(/)
    }
  })

  it('applySurfaceStyle lumen under Clean leaves both surface classes off', () => {
    document.documentElement.classList.add('surface-soft', 'surface-lumen')
    applyDesignSystem('clean')
    applySurfaceStyle('lumen')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('applySurfaceStyle lumen under Signature turns surface-lumen on and surface-soft off', () => {
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-soft')
    applySurfaceStyle('lumen')
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })

  it('applySurfaceStyle soft under Signature strips leftover surface-lumen', () => {
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-lumen')
    applySurfaceStyle('soft')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })
})

// AA guard for CTA fills on Signature and Clean (Clay has its own block below).
// `gradient-primary` buttons paint --grad-accent-fill (solid --color-accent-fill
// when gradients are off or under Clean) behind --color-fg-inverse (white), so
// every colour stop must clear 4.5:1 with white. --grad-primary is decorative
// (gradient-border-primary) and never sits behind text.
describe('applyAccent — CTA fill contrast (Signature, Clean)', () => {
  const CASES = (['signature', 'clean'] as const).flatMap((ds) =>
    (['light', 'dark'] as const).flatMap((mode) =>
      ALL_PRESETS.flatMap((preset) =>
        (['on', 'off'] as const).map((gradients) => [ds, mode, preset, gradients] as const),
      ),
    ),
  )

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove('dark', 'ds-clean', 'ds-signature')
  })

  it.each(CASES)(
    'white CTA text clears AA on %s %s %s accent-fill (gradients %s)',
    (ds, mode, preset, gradients) => {
      document.documentElement.style.cssText = ''
      applyDesignSystem(ds)
      document.documentElement.classList.toggle('dark', mode === 'dark')
      setGradientEnabled(gradients === 'on')
      paint(preset)
      const stops = [
        readVar('--color-accent-fill'),
        ...(readVar('--grad-accent-fill').match(/oklch\([^)]*\)|#[0-9a-f]{6}/gi) ?? []),
      ]
      expect(stops.length).toBeGreaterThan(1)
      for (const stop of stops) {
        expect(getContrastRatio('#ffffff', toHex(stop)), stop).toBeGreaterThanOrEqual(4.5)
      }
    },
  )
})

// Lumen pins Night Foundry brass in applyAccent and keeps Signature-style
// glows. Inline tokens beat CSS, so the pin must run the generic chromatic
// path (not orange fixed-hex, not Clean flatten) regardless of the persisted
// preset.
describe('applyAccent — Lumen honors the user preset', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    document.documentElement.classList.add('dark')
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-lumen')
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  function expectGlowsKept(): void {
    const root = document.documentElement
    expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).not.toBe('none')
    expect(root.style.getPropertyValue('--grad-primary')).toContain('gradient')
  }

  it('applies sky (not brass) and does not flatten glows', () => {
    applyAccent('sky', null)
    const root = document.documentElement
    expect(root.style.getPropertyValue('--surface-hue')).toBe('230')
    expect(root.style.getPropertyValue('--color-accent')).toContain('230')
    expect(root.style.getPropertyValue('--surface-chroma-scale')).not.toBe('0')
    expectGlowsKept()
  })
})

// Clay accent tokens are written inline by applyAccent — globals.test.ts
// cannot see them. These computed-contrast checks are the AA net for the
// Clay Press accent sheet (docs/design/DESIGN_clay.md §4).
describe('applyAccent — Clay computed contrast', () => {
  /** canvas, canvas-soft */
  const CLAY_LIGHT_PAPERS = ['#ebe3d6', '#f7f1e6']
  /** canvas, canvas-soft, neu */
  const CLAY_DARK_PAPERS = ['#171513', '#201d1a', '#2c2926']

  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-clay',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-clay',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  it('oklchToHex + getContrastRatio sees black/white as 21:1', () => {
    expect(getContrastRatio(oklchToHex('oklch(0 0 0)'), oklchToHex('oklch(1 0 0)'))).toBeCloseTo(
      21,
      0,
    )
  })

  it('keeps clay accentText ≥ 4.5:1 on canvas and canvas-soft in light for every preset', () => {
    applyDesignSystem('clay')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const text = toHex(readVar('--color-accent-text'))
      for (const paper of CLAY_LIGHT_PAPERS) {
        expect(getContrastRatio(text, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps clay accentText ≥ 4.5:1 on canvas, canvas-soft and neu in dark for every preset', () => {
    applyDesignSystem('clay')
    document.documentElement.classList.add('dark')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const text = toHex(readVar('--color-accent-text'))
      for (const paper of CLAY_DARK_PAPERS) {
        expect(getContrastRatio(text, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  // WCAG 1.4.11 non-text: the keyboard ring must clear 3:1 on the paper it is
  // drawn against. Clay light's hairline is only 1.21:1, so the ring is the
  // ONLY boundary a keyboard user gets — the pastel slab fill (`acc`) measured
  // 2.07–2.71 on four of six presets.
  it('keeps the clay focus ring ≥ 3:1 on canvas and canvas-soft in light for every preset', () => {
    applyDesignSystem('clay')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const ring = toHex(readVar('--color-focus-ring'))
      for (const paper of CLAY_LIGHT_PAPERS) {
        expect(getContrastRatio(ring, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps the clay focus ring ≥ 3:1 on canvas and canvas-soft in dark for every preset', () => {
    applyDesignSystem('clay')
    document.documentElement.classList.add('dark')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const ring = toHex(readVar('--color-focus-ring'))
      for (const paper of CLAY_DARK_PAPERS) {
        expect(getContrastRatio(ring, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps the dark accent ink ≥ 4.5:1 on --color-accent-fill for every preset', () => {
    applyDesignSystem('clay')
    document.documentElement.classList.add('dark')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const ink = toHex(readVar('--color-accent-ink'))
      const fill = toHex(readVar('--color-accent-fill'))
      expect(getContrastRatio(ink, fill), preset).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('paints every named preset from the kit sheet in both modes', () => {
    applyDesignSystem('clay')
    for (const mode of ['light', 'dark'] as const) {
      document.documentElement.classList.toggle('dark', mode === 'dark')
      for (const preset of NAMED_PRESETS) {
        paint(preset)
        const sheet = CLAY_ACCENTS[preset][mode]
        expect(readVar('--color-accent'), `${mode}/${preset}`).toBe(sheet.acc)
        expect(readVar('--color-accent-fill'), `${mode}/${preset}`).toBe(sheet.acc)
        expect(readVar('--color-accent-deep'), `${mode}/${preset}`).toBe(sheet.deep)
        expect(readVar('--color-accent-wash'), `${mode}/${preset}`).toBe(sheet.wash)
        expect(readVar('--color-accent-ink'), `${mode}/${preset}`).toBe(
          mode === 'dark' ? sheet.ink : 'var(--color-fg-inverse)',
        )
        expect(readVar('--color-accent-soft'), `${mode}/${preset}`).toBe(sheet.ghost)
        expect(readVar('--color-accent-text'), `${mode}/${preset}`).toBe(sheet.text)
      }
    }
  })

  it('falls back to the sky sheet for a stale preset id under Clay', () => {
    applyDesignSystem('clay')
    applyAccent('amber' as AccentPreset, null)
    expect(readVar('--color-accent')).toBe(CLAY_ACCENTS.sky.light.acc)
  })
})

describe('gray (grayscale) preset', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove('dark')
    setGradientEnabled(true)
  })

  // Parse the leading lightness percentage out of an `oklch(L% C H)` string.
  function oklchLightness(s: string): number {
    const m = s.match(/oklch\(\s*([\d.]+)%/)
    if (!m) throw new Error(`not an oklch() value: ${s}`)
    return Number(m[1]) / 100
  }

  // White-on-color contrast for an ACHROMATIC color (chroma 0): relative
  // luminance is exactly Y = L³, so contrast = 1.05 / (L³ + 0.05).
  function whiteContrastForGray(l: number): number {
    return 1.05 / (Math.pow(l, 3) + 0.05)
  }

  // AA GUARD (load-bearing): a future tweak to the gray accent L that drops
  // white-on-accent below WCAG AA 4.5:1 must fail this test. CLAUDE.md marks AA
  // as non-negotiable.
  it('keeps white-on-accent contrast above AA in light mode', () => {
    applyAccent('gray', null)
    const l = oklchLightness(document.documentElement.style.getPropertyValue('--color-accent'))
    expect(whiteContrastForGray(l)).toBeGreaterThanOrEqual(4.5)
  })

  // Guard the chroma-0 contract across EVERY accent token (not just --color-accent),
  // in both modes. A refactor of buildTokens that re-introduces chroma on any of
  // these would break the grayscale promise; this catches it.
  const ACCENT_VARS = [
    '--color-accent',
    '--color-accent-hover',
    '--color-accent-soft',
    '--color-editor-selection',
    '--color-accent-text',
    '--color-focus-ring',
    '--grad-accent-soft',
    '--selected-border',
  ]
  for (const mode of ['light', 'dark'] as const) {
    it(`renders all accent tokens at chroma 0 (${mode})`, () => {
      document.documentElement.classList.toggle('dark', mode === 'dark')
      applyAccent('gray', null)
      for (const v of ACCENT_VARS) {
        const val = document.documentElement.style.getPropertyValue(v)
        // Every oklch() in the token must have a 0 chroma slot: `L% 0 H`.
        const stops = val.match(/oklch\([^)]*\)/g) ?? []
        expect(stops.length).toBeGreaterThan(0)
        for (const stop of stops) {
          expect(stop).toMatch(/oklch\(\s*[\d.]+%\s+0\s/)
        }
      }
    })
  }

  it('zeros --surface-chroma-scale for gray and resets it to 1 for a chromatic preset', () => {
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--surface-chroma-scale')).toBe('0')
    // Reset trap: the inline `0` persists on documentElement, so switching to a
    // chromatic preset MUST write `1` back — otherwise violet's surfaces would
    // stay neutral too.
    applyAccent('violet', null)
    expect(document.documentElement.style.getPropertyValue('--surface-chroma-scale')).toBe('1')
  })
})

describe('applyFont', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('sets Open Sans for open-sans with bumped weight 500', () => {
    applyFont('open-sans')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Open Sans',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toContain(
      'Open Sans',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('500')
  })

  it('does NOT touch app-level --font-display or --font-sans (Font setting is editor-only)', () => {
    applyFont('inter')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('')
  })
})

describe('clampFontSize', () => {
  it('returns FONT_SIZE_DEFAULT for non-finite input', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT)
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT)
  })

  it('clamps to FONT_SIZE_MIN below the floor', () => {
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(FONT_SIZE_MIN - 1)).toBe(FONT_SIZE_MIN)
  })

  it('clamps to FONT_SIZE_MAX above the ceiling', () => {
    expect(clampFontSize(FONT_SIZE_MAX + 1)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX)
  })

  it('rounds non-integer input to nearest integer', () => {
    expect(clampFontSize(14.4)).toBe(14)
    expect(clampFontSize(14.6)).toBe(15)
    expect(clampFontSize(15.5)).toBe(16)
  })

  it('passes through valid in-range integers unchanged', () => {
    expect(clampFontSize(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(15)).toBe(15)
    expect(clampFontSize(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX)
  })
})

describe('clampFontContrast', () => {
  it('returns FONT_CONTRAST_DEFAULT for non-finite input', () => {
    expect(clampFontContrast(Number.NaN)).toBe(FONT_CONTRAST_DEFAULT)
  })

  it('clamps to FONT_CONTRAST_MIN below the floor', () => {
    expect(clampFontContrast(0)).toBe(FONT_CONTRAST_MIN)
    expect(clampFontContrast(-1)).toBe(FONT_CONTRAST_MIN)
  })

  it('clamps to FONT_CONTRAST_MAX above the ceiling', () => {
    expect(clampFontContrast(2)).toBe(FONT_CONTRAST_MAX)
  })

  it('snaps to step grid (0.05) to avoid float drift across persist cycles', () => {
    // Pick values inside [FONT_CONTRAST_MIN, FONT_CONTRAST_MAX] so the clamp
    // doesn't dominate — we're isolating the step-snap behavior here.
    expect(clampFontContrast(0.73)).toBeCloseTo(0.75, 5)
    expect(clampFontContrast(0.86)).toBeCloseTo(0.85, 5)
    expect(clampFontContrast(0.875)).toBeCloseTo(0.9, 5)
  })

  it('returns exact decimals (no float artifacts) for in-range values', () => {
    // Was failing before the round-to-2-decimals fix: 0.7 → 0.7000000000000001.
    expect(clampFontContrast(0.7)).toBe(0.7)
    expect(clampFontContrast(0.85)).toBe(0.85)
  })
})

describe('applyFontSize', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('clamps before applying (out-of-range input never reaches the DOM)', () => {
    applyFontSize(999)
    expect(document.documentElement.style.getPropertyValue('--font-editor-size')).toBe(
      `${FONT_SIZE_MAX}px`,
    )
  })
})

describe('applyFontContrast', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('clamps before applying', () => {
    applyFontContrast(0)
    expect(
      Number.parseFloat(document.documentElement.style.getPropertyValue('--font-editor-fg-alpha')),
    ).toBeCloseTo(FONT_CONTRAST_MIN, 5)
  })
})

describe('applyFont — custom variant', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('uses the custom family name and weight when family is "custom"', () => {
    applyFont('custom', 'Merriweather', 700)
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toBe(
      "'Merriweather', system-ui, sans-serif",
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toBe(
      "'Merriweather', system-ui, sans-serif",
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('700')
  })

  it('falls through to FONT_MAP placeholder when custom name is missing', () => {
    applyFont('custom', null, null)
    // Placeholder display is system-ui, sans-serif (no quotes around family).
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toBe(
      'system-ui, sans-serif',
    )
  })

  it('strips embedded quotes/backslashes/semicolons from custom family name (defense-in-depth)', () => {
    applyFont('custom', `Mali'cious"\\;name`, 400)
    const css = document.documentElement.style.getPropertyValue('--font-editor-display')
    // Only the wrapping quotes remain; every sanitised char inside is gone.
    expect(css).toBe("'Maliciousname', system-ui, sans-serif")
  })

  it('sanitises quotes/backslashes/semicolons from <font-family> in @font-face rule too', () => {
    document.getElementById('custom-google-font')?.remove()
    loadCustomGoogleFont(`Roboto";color:red;`, 400, 'asset://x.woff2')
    const el = document.getElementById('custom-google-font') as HTMLStyleElement
    // The injected `;` and `"` are stripped — the trailing `:red` survives
    // but is harmless inside the single-quoted font-family string literal.
    expect(el.textContent).toContain("font-family: 'Robotocolor:red'")
    expect(el.textContent).not.toContain(';color')
  })
})

describe('loadCustomGoogleFont / unloadCustomGoogleFont', () => {
  beforeEach(() => {
    // Remove any prior <style id="custom-google-font">.
    document.getElementById('custom-google-font')?.remove()
  })

  it('replaces (does not duplicate) the style element on repeat calls', () => {
    loadCustomGoogleFont('A', 400, 'asset://a.woff2')
    loadCustomGoogleFont('B', 700, 'asset://b.woff2')
    const all = document.querySelectorAll('#custom-google-font')
    expect(all.length).toBe(1)
    expect(all[0].textContent).toContain("font-family: 'B'")
    expect(all[0].textContent).toContain('font-weight: 700')
  })
})
