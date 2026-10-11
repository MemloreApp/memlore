import { describe, expect, it } from 'vitest'
import en from '../locales/en/ai.json'
import { PROVIDER_PRESETS } from './ai'

/**
 * `AIProviderSetupHint` resolves its copy from `provider_hint.<presetId>` at
 * runtime, so a preset whose key is missing renders nothing at all — silently,
 * with no compile error (the old required `setupHint` field used to catch
 * this). These tests are that guard: every preset must have a hint, and no
 * hint may outlive its preset. Checked on `en` only — `jsonKeyParity.test.ts`
 * already holds `vi` to the same keys with non-empty values.
 */
describe('provider_hint i18n coverage', () => {
  const presetIds = PROVIDER_PRESETS.map((p) => p.id)
  const hints = (en as { provider_hint: Record<string, string> }).provider_hint

  it('[en] has a non-empty hint for every provider preset', () => {
    const missing = presetIds.filter((id) => !hints[id]?.trim())
    expect(missing).toEqual([])
  })

  it('[en] has no hint for a preset that no longer exists', () => {
    const orphaned = Object.keys(hints).filter((id) => !presetIds.includes(id as never))
    expect(orphaned).toEqual([])
  })
})
