import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import MemloreCore, {
  type AutoLockSeconds,
  type BiometricKind,
  type MemloreErrorCode,
} from '@/modules/memlore-core';

export type VaultStatus =
  | 'loading'
  | 'first_launch'
  | 'show_phrase'
  | 'locked'
  | 'unlocked'
  | 'boot_file_corrupt'
  | 'error';

/**
 * What the screen shows under the form: a wrong password, Face ID/Touch ID
 * that cannot be used now, or anything else.
 */
export type VaultError = 'wrong_password' | 'biometric_disabled' | 'failed';

/** Face ID/Touch ID on this device and for this vault. */
export interface VaultBiometric {
  /** Enrolled and usable now. */
  available: boolean;
  kind: BiometricKind;
  /** This vault unlocks with Face ID/Touch ID on this device. */
  enabled: boolean;
}

const NO_BIOMETRIC: VaultBiometric = { available: false, kind: 'none', enabled: false };

const ERROR_CODES: readonly MemloreErrorCode[] = [
  'ERR_LOCKED',
  'ERR_WRONG_PASSWORD',
  'ERR_IO',
  'ERR_FORMAT',
  'ERR_BIOMETRIC_DISABLED',
  'ERR_BIOMETRIC_CANCELLED',
];

function errorCode(e: unknown): MemloreErrorCode | null {
  if (typeof e !== 'object' || e === null || !('code' in e)) return null;
  return ERROR_CODES.find((code) => code === e.code) ?? null;
}

/**
 * The vault lifecycle for the home screen. Components use this hook, never
 * the native module.
 */
export function useVault() {
  const [status, setStatus] = useState<VaultStatus>('loading');
  const [error, setError] = useState<VaultError | null>(null);
  const [busy, setBusy] = useState(false);
  // A Face ID/Touch ID unlock prompt is up. Apart from `busy`, so the password
  // form does not read "Unlocking…" while the system sheet is shown.
  const [biometricPrompting, setBiometricPrompting] = useState(false);
  const [entryCount, setEntryCount] = useState<number | null>(null);
  // Shown once after creation; cleared as soon as the user confirms. An
  // auto-lock on the phrase screen keeps it, and the next unlock shows it again.
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [biometric, setBiometric] = useState<VaultBiometric>(NO_BIOMETRIC);
  // Read from the vault after each unlock; null while locked.
  const [autoLockSeconds, setAutoLockValue] = useState<AutoLockSeconds | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  // An auto-lock left the native privacy shield up; it comes off once the
  // lock screen has rendered.
  const [shieldHeld, setShieldHeld] = useState(false);
  // One automatic Face ID/Touch ID prompt per lock event. Consumed when it
  // fires, so a cancel never brings it back; the button always prompts.
  const [autoPromptPending, setAutoPromptPending] = useState(false);
  // Set synchronously, unlike `busy`: a second tap in the same frame (or
  // onSubmitEditing racing the button) must not start a second engine call.
  const inFlight = useRef(false);

  function checkStartup(isCancelled: () => boolean = () => false) {
    MemloreCore.startupMode()
      .then((mode) => {
        if (__DEV__) console.log('[useVault] startupMode =', mode);
        if (isCancelled()) return;
        if (mode === 'first_launch') setStatus('first_launch');
        else if (mode === 'boot_file_corrupt') setStatus('boot_file_corrupt');
        else enterLocked();
        void refreshBiometric();
      })
      .catch(() => {
        if (!isCancelled()) setStatus('error');
      });
  }

  useEffect(() => {
    let cancelled = false;
    checkStartup(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const appState = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    // The vault is already locked (or locking) natively, and the app is not
    // active yet. Never prompt from here: the effects below do, once the
    // shield is off and the app is active.
    const autoLock = MemloreCore.addListener('onAutoLock', () => {
      setAppActive(false);
      showLocked();
      setShieldHeld(true);
      void refreshBiometric();
    });
    return () => {
      appState.remove();
      autoLock.remove();
    };
  }, []);

  // After an auto-lock, once the lock screen has rendered: take the shield
  // off, then arm the Face ID prompt.
  useEffect(() => {
    if (!shieldHeld || status !== 'locked') return;
    MemloreCore.releasePrivacyShield()
      // The native safety timeout takes it off anyway.
      .catch(() => {})
      .finally(() => {
        setShieldHeld(false);
        setAutoPromptPending(true);
      });
  }, [shieldHeld, status]);

  /** Re-runs the startup check from the `error` screen. */
  function retry() {
    setStatus('loading');
    checkStartup();
  }

  /** Drops everything read from the vault and shows the lock screen. */
  function showLocked() {
    setError(null);
    setEntryCount(null);
    setAutoLockValue(null);
    setStatus('locked');
  }

  /**
   * A cold start: the lock screen, then one prompt. The auto-lock arms its own
   * once the shield is off; a manual lock never does (it would unlock again at
   * once), so it calls `showLocked` instead.
   */
  function enterLocked() {
    showLocked();
    setAutoPromptPending(true);
  }

  /**
   * After a password or Face ID unlock: back to a pending recovery phrase,
   * else the vault.
   */
  async function enterUnlocked() {
    setAutoPromptPending(false);
    void refreshBiometric();
    void refreshAutoLock();
    if (recoveryPhrase !== null) {
      setStatus('show_phrase');
      return;
    }
    setStatus('unlocked');
    await refreshCount();
  }

  /** Reads the entry count. False when the vault turned out to be locked. */
  async function refreshCount(): Promise<boolean> {
    try {
      setEntryCount(await MemloreCore.entryCount());
    } catch (e) {
      if (errorCode(e) === 'ERR_LOCKED') {
        showLocked();
        return false;
      }
      setError('failed');
    }
    return true;
  }

  /**
   * Face ID/Touch ID state. Never fails: a failed read keeps the last state
   * (a stale button then gets ERR_BIOMETRIC_DISABLED and refreshes again).
   */
  async function refreshBiometric() {
    try {
      const [device, enabled] = await Promise.all([
        MemloreCore.biometricStatus(),
        MemloreCore.isBiometricUnlockEnabled(),
      ]);
      setBiometric({ available: device.available, kind: device.kind, enabled });
    } catch {
      // Keeps the last state; the password always works.
    }
  }

  /** Only while unlocked: the engine rejects the read while locked. */
  async function refreshAutoLock() {
    try {
      setAutoLockValue(await MemloreCore.autoLockSeconds());
    } catch {
      setAutoLockValue(null);
    }
  }

  /**
   * Runs one engine call with a pending flag (`busy` unless given another)
   * and the error mapping. A call made while another is in flight is ignored
   * and returns false.
   */
  async function run(
    action: () => Promise<void>,
    setPending: (pending: boolean) => void = setBusy,
  ): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'ERR_LOCKED') {
        // Not an error: the vault locked under us, so show the unlock screen.
        // No prompt: the auto-lock that did it arms its own, and an unlock
        // that hit this must not retry itself in a loop.
        showLocked();
      } else if (code === 'ERR_BIOMETRIC_CANCELLED') {
        // Not an error either: the prompt was dismissed; nothing changed.
      } else if (code === 'ERR_BIOMETRIC_DISABLED') {
        // The engine's message is English; the screen shows a translated one.
        // The refresh hides the button once Face ID is off.
        setError('biometric_disabled');
        void refreshBiometric();
      } else {
        setError(code === 'ERR_WRONG_PASSWORD' ? 'wrong_password' : 'failed');
      }
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const createVault = (password: string) =>
    run(async () => {
      setRecoveryPhrase(await MemloreCore.createVault(password));
      setStatus('show_phrase');
      void refreshBiometric();
      void refreshAutoLock();
    });

  /** The vault is already unlocked after creation: go straight to it. */
  async function confirmPhraseSaved() {
    setRecoveryPhrase(null);
    setStatus('unlocked');
    await refreshCount();
  }

  const unlock = (password: string) =>
    run(async () => {
      await MemloreCore.unlock(password);
      await enterUnlocked();
    });

  /** A cancel stays locked with no message. */
  const unlockWithBiometric = () =>
    run(async () => {
      await MemloreCore.unlockWithBiometric();
      await enterUnlocked();
    }, setBiometricPrompting);

  /** A manual lock: the lock screen without a prompt (the button prompts). */
  const lock = () =>
    run(async () => {
      await MemloreCore.lock();
      showLocked();
      void refreshBiometric();
    });

  /** One Face ID/Touch ID prompt, then the key is stored. A cancel is silent. */
  const enableBiometric = () =>
    run(async () => {
      try {
        await MemloreCore.enableBiometric();
      } finally {
        // Inside the call, so `busy` covers it and the toggle never flickers.
        await refreshBiometric();
      }
    });

  const disableBiometric = () =>
    run(async () => {
      try {
        await MemloreCore.disableBiometric();
      } finally {
        await refreshBiometric();
      }
    });

  /** The selection switches at once and goes back if the write fails. */
  async function setAutoLockSeconds(seconds: AutoLockSeconds): Promise<boolean> {
    const previous = autoLockSeconds;
    setAutoLockValue(seconds);
    const ok = await run(() => MemloreCore.setAutoLockSeconds(seconds));
    // Unless a lock cleared it meanwhile.
    if (!ok) setAutoLockValue((current) => (current === seconds ? previous : current));
    return ok;
  }

  /** True only when the entry was created and the vault is still unlocked. */
  async function createEntry(title: string): Promise<boolean> {
    let unlocked = true;
    const ok = await run(async () => {
      await MemloreCore.createEntry(title);
      unlocked = await refreshCount();
    });
    return ok && unlocked;
  }

  // The automatic prompt: once per lock event, only while the lock screen is
  // up, the app is active (the Keychain prompt needs it) and the shield is
  // off. Cleared before it fires, so a cancel does not prompt again.
  useEffect(() => {
    if (!autoPromptPending || status !== 'locked' || busy || biometricPrompting) return;
    if (shieldHeld || !appActive) return;
    if (!biometric.available || !biometric.enabled) return;
    setAutoPromptPending(false);
    void unlockWithBiometric();
  }, [autoPromptPending, status, busy, biometricPrompting, shieldHeld, appActive, biometric]);

  return {
    status,
    error,
    busy,
    biometricPrompting,
    entryCount,
    recoveryPhrase,
    biometric,
    autoLockSeconds,
    createVault,
    confirmPhraseSaved,
    unlock,
    unlockWithBiometric,
    lock,
    enableBiometric,
    disableBiometric,
    setAutoLockSeconds,
    createEntry,
    retry,
  };
}
