import { useEffect, useRef, useState } from 'react';

import MemloreCore, { type MemloreErrorCode } from '@/modules/memlore-core';

export type VaultStatus =
  | 'loading'
  | 'first_launch'
  | 'show_phrase'
  | 'locked'
  | 'unlocked'
  | 'boot_file_corrupt'
  | 'error';

/** What the screen shows under the form: a wrong password, or anything else. */
export type VaultError = 'wrong_password' | 'failed';

const ERROR_CODES: readonly MemloreErrorCode[] = [
  'ERR_LOCKED',
  'ERR_WRONG_PASSWORD',
  'ERR_IO',
  'ERR_FORMAT',
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
  const [entryCount, setEntryCount] = useState<number | null>(null);
  // Shown once after creation; cleared as soon as the user confirms.
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
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
        else setStatus('locked');
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

  /** Re-runs the startup check from the `error` screen. */
  function retry() {
    setStatus('loading');
    checkStartup();
  }

  /** Reads the entry count. False when the vault turned out to be locked. */
  async function refreshCount(): Promise<boolean> {
    try {
      setEntryCount(await MemloreCore.entryCount());
    } catch (e) {
      if (errorCode(e) === 'ERR_LOCKED') {
        setEntryCount(null);
        setStatus('locked');
        return false;
      }
      setError('failed');
    }
    return true;
  }

  /**
   * Runs one engine call with the busy flag and the error mapping. A call
   * made while another is in flight is ignored and returns false.
   */
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'ERR_LOCKED') {
        // Not an error: the vault locked under us, so show the unlock screen.
        setEntryCount(null);
        setStatus('locked');
      } else {
        setError(code === 'ERR_WRONG_PASSWORD' ? 'wrong_password' : 'failed');
      }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const createVault = (password: string) =>
    run(async () => {
      setRecoveryPhrase(await MemloreCore.createVault(password));
      setStatus('show_phrase');
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
      setStatus('unlocked');
      await refreshCount();
    });

  const lock = () =>
    run(async () => {
      await MemloreCore.lock();
      setEntryCount(null);
      setStatus('locked');
    });

  /** True only when the entry was created and the vault is still unlocked. */
  async function createEntry(title: string): Promise<boolean> {
    let unlocked = true;
    const ok = await run(async () => {
      await MemloreCore.createEntry(title);
      unlocked = await refreshCount();
    });
    return ok && unlocked;
  }

  return {
    status,
    error,
    busy,
    entryCount,
    recoveryPhrase,
    createVault,
    confirmPhraseSaved,
    unlock,
    lock,
    createEntry,
    retry,
  };
}
