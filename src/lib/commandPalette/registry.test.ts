import { describe, expect, it } from 'vitest'
import { getCommands } from './registry'
import { useUiStore } from '../../stores/uiStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import en from '../../locales/en/palette.json'

describe('getCommands', () => {
  it('theme toggle commands are available under Signature except the current theme', () => {
    const commands = getCommands()
    const darkCmd = commands.find((c) => c.id === 'action.toggle_theme_dark')
    const lightCmd = commands.find((c) => c.id === 'action.toggle_theme_light')

    useUiStore.setState({ designSystem: 'signature' })
    for (const theme of ['dark', 'light'] as const) {
      useUiStore.setState({ theme })
      expect(darkCmd?.available?.()).toBe(theme !== 'dark')
      expect(lightCmd?.available?.()).toBe(theme !== 'light')
    }
  })

  it('second-lock commands gate by session state', () => {
    const commands = getCommands()
    const unlockCmd = commands.find((c) => c.id === 'action.unlock_second_lock')
    const lockCmd = commands.find((c) => c.id === 'action.lock_second_lock')

    useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false })
    expect(unlockCmd?.available?.()).toBe(false)
    expect(lockCmd?.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false })
    expect(unlockCmd?.available?.()).toBe(true)
    expect(lockCmd?.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    expect(unlockCmd?.available?.()).toBe(false)
    expect(lockCmd?.available?.()).toBe(true)

    lockCmd?.run()
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('invisible-lock commands expose unlock and gate lock by session state', () => {
    const commands = getCommands()
    const unlockCmd = commands.find((c) => c.id === 'action.unlock_invisible')
    const lockCmd = commands.find((c) => c.id === 'action.lock_invisible')

    useInvisibleLockStore.setState({ activeVaultId: null })
    // Unlock is always exposed on desktop (gated only by capabilities.secondLock).
    expect(unlockCmd?.available?.()).toBe(true)
    expect(lockCmd?.available?.()).toBe(false)

    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    expect(lockCmd?.available?.()).toBe(true)

    lockCmd?.run()
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })
})

// ── Cross-cutting assertions ────────────────────────────────────────────

describe('command id uniqueness', () => {
  it('all command ids are unique', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })
})

describe('i18n key coverage', () => {
  /** Resolve a dot-path key against a nested object. */
  function resolve(obj: Record<string, unknown>, path: string): unknown {
    let cur: unknown = obj
    for (const segment of path.split('.')) {
      if (typeof cur !== 'object' || cur === null) return undefined
      cur = (cur as Record<string, unknown>)[segment]
    }
    return cur
  }

  it('every generated labelKey exists in en/palette.json', () => {
    const commands = getCommands()
    const missing: string[] = []
    for (const cmd of commands) {
      if (cmd.labelKey.startsWith('@@')) continue // dynamic labels
      if (resolve(en, cmd.labelKey) === undefined) {
        missing.push(cmd.labelKey)
      }
    }
    expect(missing).toEqual([])
  })
})

// ── Gating behaviour ────────────────────────────────────────────────────

describe('toggle gating', () => {
  it('appearance reduced_motion: exactly one of enable/disable is available', () => {
    const commands = getCommands()
    const enableRM = commands.find((c) => c.id === 'settings_value.reduced_motion.enable')!
    const disableRM = commands.find((c) => c.id === 'settings_value.reduced_motion.disable')!

    useUiStore.setState({ reducedMotion: true })
    expect(enableRM.available?.()).toBe(false)
    expect(disableRM.available?.()).toBe(true)

    useUiStore.setState({ reducedMotion: false })
    expect(enableRM.available?.()).toBe(true)
    expect(disableRM.available?.()).toBe(false)
  })

  it('second_lock_show_existence: available only when second lock enabled', () => {
    const commands = getCommands()
    const enableCmd = commands.find(
      (c) => c.id === 'settings_value.second_lock_show_existence.enable',
    )!
    const disableCmd = commands.find(
      (c) => c.id === 'settings_value.second_lock_show_existence.disable',
    )!

    useSecondLockStore.setState({ isEnabled: false, showExistence: false })
    expect(enableCmd.available?.()).toBe(false)
    expect(disableCmd.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, showExistence: false })
    expect(enableCmd.available?.()).toBe(true)
    expect(disableCmd.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, showExistence: true })
    expect(enableCmd.available?.()).toBe(false)
    expect(disableCmd.available?.()).toBe(true)
  })
})

describe('pill gating', () => {
  it('design_system: current value is hidden', () => {
    const commands = getCommands()
    const sigCmd = commands.find((c) => c.id === 'settings_value.design_system.signature')!
    const cleanCmd = commands.find((c) => c.id === 'settings_value.design_system.clean')!

    useUiStore.setState({ designSystem: 'signature' })
    expect(sigCmd.available?.()).toBe(false)
    expect(cleanCmd.available?.()).toBe(true)

    useUiStore.setState({ designSystem: 'clean' })
    expect(sigCmd.available?.()).toBe(true)
    expect(cleanCmd.available?.()).toBe(false)
  })

  it('surface_style: available only when signature', () => {
    const commands = getCommands()
    const deepCmd = commands.find((c) => c.id === 'settings_value.surface_style.deep')
    const softCmd = commands.find((c) => c.id === 'settings_value.surface_style.soft')
    const lumenCmd = commands.find((c) => c.id === 'settings_value.surface_style.lumen')
    expect(deepCmd).toBeDefined()
    expect(softCmd).toBeDefined()
    expect(lumenCmd).toBeDefined()
    expect(commands.some((c) => c.id === 'settings_value.design_system.lumen')).toBe(false)

    useUiStore.setState({ designSystem: 'clean' })
    expect(deepCmd?.available?.()).toBe(false)
    expect(softCmd?.available?.()).toBe(false)
    expect(lumenCmd?.available?.()).toBe(false)

    useUiStore.setState({ designSystem: 'signature' })
    // At least one non-current value should be available
    const deepAvail = deepCmd?.available?.()
    const softAvail = softCmd?.available?.()
    const lumenAvail = lumenCmd?.available?.()
    expect(deepAvail || softAvail || lumenAvail).toBe(true)
  })
})
