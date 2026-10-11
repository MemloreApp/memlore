import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { keyPaths } from './keyParity'

// See `keyParity.ts` for why this test exists and how plural suffixes are
// handled. Namespaces are discovered from `en/`, so a new bundle is covered
// without touching this file.
const EN_DIR = resolve(__dirname, 'en')
const VI_DIR = resolve(__dirname, 'vi')
const NAMESPACES = readdirSync(EN_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort()

function load(dir: string, ns: string): object {
  return JSON.parse(readFileSync(resolve(dir, `${ns}.json`), 'utf8')) as object
}

/** Dotted paths of leaves that are not a non-empty string (`_` keys skipped). */
function emptyLeaves(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'string' && value.trim() !== '' ? [] : [prefix]
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !key.startsWith('_'))
    .flatMap(([key, child]) => emptyLeaves(child, prefix ? `${prefix}.${key}` : key))
}

function leaf(bundle: object, path: string): string {
  const value = path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined
    return (acc as Record<string, unknown>)[key]
  }, bundle)
  if (typeof value !== 'string') {
    throw new Error(`missing string at ${path}`)
  }
  return value
}

it('discovers at least one namespace', () => {
  expect(NAMESPACES.length).toBeGreaterThan(0)
})

describe.each(NAMESPACES)('%s.json', (ns) => {
  it('exists in vi', () => {
    expect(existsSync(resolve(VI_DIR, `${ns}.json`)), `vi/${ns}.json is missing`).toBe(true)
  })

  it('has the same keys in en and vi', () => {
    const enKeys = keyPaths(load(EN_DIR, ns))
    const viKeys = keyPaths(load(VI_DIR, ns))
    expect(enKeys.size).toBeGreaterThan(0)
    expect({
      missingFromVi: [...enKeys].filter((k) => !viKeys.has(k)),
      extraInVi: [...viKeys].filter((k) => !enKeys.has(k)),
    }).toEqual({ missingFromVi: [], extraInVi: [] })
  })

  it('has no empty values in en or vi', () => {
    expect({
      en: emptyLeaves(load(EN_DIR, ns)),
      vi: emptyLeaves(load(VI_DIR, ns)),
    }).toEqual({ en: [], vi: [] })
  })
})

// auth.json-specific: the onboarding cloud step is provider-neutral, so its
// copy must interpolate {{provider}}, while OAuth-only strings stay Google.
describe('auth.json cloud-provider interpolation', () => {
  const en = load(EN_DIR, 'auth')
  const vi = load(VI_DIR, 'auth')

  const PROVIDER_KEYS = [
    'welcome_first_run.existing_cloud_connecting',
    'welcome_first_run.cloud_empty_title',
    'welcome_first_run.cloud_empty_body',
    'welcome_first_run.existing_cloud_error_generic',
    'welcome_first_run.existing_cloud_error_unsafe_setup',
    'welcome_first_run.existing_cloud_error_cloud_vault_exists',
    'onboarding.drive.connect_button',
    'onboarding.drive.connecting',
    'onboarding.drive.connected',
    'onboarding.drive.error_generic',
    'onboarding.drive.background_failed',
  ]

  const OAUTH_ONLY_KEYS = [
    'onboarding.drive.progress.exchanging_token',
    'welcome_first_run.existing_cloud_error_pending_session_expired',
  ]

  it('adds onboarding.drive.picker_hint in both locales', () => {
    expect(leaf(en, 'onboarding.drive.picker_hint').length).toBeGreaterThan(0)
    expect(leaf(vi, 'onboarding.drive.picker_hint').length).toBeGreaterThan(0)
  })

  it('interpolates {{provider}} on welcome + drive connect copy', () => {
    for (const path of PROVIDER_KEYS) {
      expect(leaf(en, path), path).toContain('{{provider}}')
      expect(leaf(vi, path), path).toContain('{{provider}}')
    }
  })

  it('keeps OAuth-only Google strings without {{provider}}', () => {
    for (const path of OAUTH_ONLY_KEYS) {
      for (const value of [leaf(en, path), leaf(vi, path)]) {
        expect(value, path).toMatch(/Google/)
        expect(value, path).not.toContain('{{provider}}')
      }
    }
  })

  it('rewrites the drive-step title as provider-neutral', () => {
    expect(leaf(en, 'onboarding.drive.title')).toBe('Sync with a cloud service')
    expect(leaf(en, 'onboarding.drive.title')).not.toMatch(/Google/)
    expect(leaf(vi, 'onboarding.drive.title')).not.toMatch(/Google/)
  })
})
