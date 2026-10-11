import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DESIGN_SYSTEMS,
  DEFAULT_DESIGN_SYSTEM,
  DESIGN_SYSTEM_CLASS,
  coerceDesignSystem,
  coerceSurfaceStyle,
  coerceCornerRadius,
  lightModeAllowed,
  applyDesignSystem,
  applyCornerRadius,
  readActiveDesignSystem,
} from './designSystem'
import { LIGHT_MODE_ENABLED } from './themeConfig'

describe('coerceDesignSystem', () => {
  it("maps 'clean' to 'clean'", () => {
    expect(coerceDesignSystem('clean')).toBe('clean')
  })

  it("maps 'signature' to 'signature'", () => {
    expect(coerceDesignSystem('signature')).toBe('signature')
  })

  it("maps 'clay' to 'clay'", () => {
    expect(coerceDesignSystem('clay')).toBe('clay')
  })

  it("maps leftover 'lumen' to the default", () => {
    expect(coerceDesignSystem('lumen')).toBe(DEFAULT_DESIGN_SYSTEM)
  })

  it("maps class-name 'ds-clay' to the default", () => {
    expect(coerceDesignSystem('ds-clay')).toBe(DEFAULT_DESIGN_SYSTEM)
  })

  it("maps undefined / null / 'superx' / 42 to the default", () => {
    expect(coerceDesignSystem(undefined)).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem(null)).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem('superx')).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem(42)).toBe(DEFAULT_DESIGN_SYSTEM)
  })
})

describe('coerceSurfaceStyle', () => {
  it('round-trips deep, soft, and lumen', () => {
    expect(coerceSurfaceStyle('deep')).toBe('deep')
    expect(coerceSurfaceStyle('soft')).toBe('soft')
    expect(coerceSurfaceStyle('lumen')).toBe('lumen')
  })

  it("maps undefined / null / 'warm' / 42 to 'deep'", () => {
    expect(coerceSurfaceStyle(undefined)).toBe('deep')
    expect(coerceSurfaceStyle(null)).toBe('deep')
    expect(coerceSurfaceStyle('warm')).toBe('deep')
    expect(coerceSurfaceStyle(42)).toBe('deep')
  })
})

describe('coerceCornerRadius', () => {
  it("maps 'low' to 'low'", () => {
    expect(coerceCornerRadius('low')).toBe('low')
  })

  it("maps 'medium' to 'medium'", () => {
    expect(coerceCornerRadius('medium')).toBe('medium')
  })

  it("maps 'high' to 'high'", () => {
    expect(coerceCornerRadius('high')).toBe('high')
  })

  it("maps undefined / null / 'lumen' / 'HIGH' / 42 to 'high'", () => {
    expect(coerceCornerRadius(undefined)).toBe('high')
    expect(coerceCornerRadius(null)).toBe('high')
    expect(coerceCornerRadius('lumen')).toBe('high')
    expect(coerceCornerRadius('HIGH')).toBe('high')
    expect(coerceCornerRadius(42)).toBe('high')
  })
})

describe('lightModeAllowed', () => {
  it('allows light mode for clean', () => {
    expect(lightModeAllowed('clean')).toBe(true)
  })

  it('allows light mode for clean even with a stored lumen surface', () => {
    expect(lightModeAllowed('clean', 'lumen')).toBe(true)
  })

  it('allows light mode for clay with every surface', () => {
    expect(lightModeAllowed('clay')).toBe(true)
    expect(lightModeAllowed('clay', 'deep')).toBe(true)
    expect(lightModeAllowed('clay', 'soft')).toBe(true)
    expect(lightModeAllowed('clay', 'lumen')).toBe(true)
  })

  it('gates signature + deep/soft on LIGHT_MODE_ENABLED', () => {
    expect(lightModeAllowed('signature')).toBe(LIGHT_MODE_ENABLED)
    expect(lightModeAllowed('signature', 'deep')).toBe(LIGHT_MODE_ENABLED)
    expect(lightModeAllowed('signature', 'soft')).toBe(LIGHT_MODE_ENABLED)
  })

  it('never allows light mode for Signature + lumen', () => {
    expect(lightModeAllowed('signature', 'lumen')).toBe(false)
  })
})

describe('applyDesignSystem / readActiveDesignSystem', () => {
  beforeEach(() => {
    document.documentElement.className = ''
  })

  afterEach(() => {
    document.documentElement.className = ''
  })

  it('leaves exactly one ds-* class for each system', () => {
    for (const ds of DESIGN_SYSTEMS) {
      applyDesignSystem(ds)
      const dsClasses = [...document.documentElement.classList].filter((c) => c.startsWith('ds-'))
      expect(dsClasses).toEqual([DESIGN_SYSTEM_CLASS[ds]])
    }
  })

  it('round-trips through readActiveDesignSystem after applyDesignSystem', () => {
    applyDesignSystem('clean')
    expect(readActiveDesignSystem()).toBe('clean')
    applyDesignSystem('signature')
    expect(readActiveDesignSystem()).toBe('signature')
  })

  it('reads clay when ds-clay is on the root', () => {
    document.documentElement.classList.add('ds-clay')
    expect(readActiveDesignSystem()).toBe('clay')
  })

  it('never returns lumen even if leftover ds-lumen is present', () => {
    document.documentElement.classList.add('ds-lumen')
    expect(readActiveDesignSystem()).toBe('signature')
    document.documentElement.classList.add('ds-lumen', 'ds-clean')
    expect(readActiveDesignSystem()).toBe('clean')
  })

  it('applyDesignSystem signature strips leftover ds-lumen', () => {
    document.documentElement.classList.add('ds-lumen', 'dark')
    applyDesignSystem('signature')
    const classes = [...document.documentElement.classList]
    expect(classes).toContain('ds-signature')
    expect(classes).toContain('dark')
    expect(classes).not.toContain('ds-lumen')
    expect(classes).not.toContain('ds-clean')
    expect(classes.filter((c) => c.startsWith('ds-'))).toEqual(['ds-signature'])
  })
})

describe('applyCornerRadius', () => {
  beforeEach(() => {
    document.documentElement.className = ''
  })

  afterEach(() => {
    document.documentElement.className = ''
  })

  it('strips the previous class when switching high → medium → low', () => {
    applyCornerRadius('high')
    expect(document.documentElement.classList.contains('rad-high')).toBe(true)
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)

    applyCornerRadius('medium')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(true)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)

    applyCornerRadius('low')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)
  })
})
