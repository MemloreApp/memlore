import { requireNativeModule } from 'expo';

/** What the vault on this device needs at launch. */
export type StartupMode = 'first_launch' | 'password_locked' | 'boot_file_corrupt';

/** `code` of the errors the native module rejects with. */
export type MemloreErrorCode = 'ERR_LOCKED' | 'ERR_WRONG_PASSWORD' | 'ERR_IO' | 'ERR_FORMAT';

interface MemloreCoreModule {
  startupMode(): Promise<StartupMode>;
  /** Creates the vault, leaves it unlocked and resolves with the 24-word phrase. */
  createVault(password: string): Promise<string>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  /** Rejects with ERR_LOCKED while the vault is locked. */
  entryCount(): Promise<number>;
  /** Creates an entry with an empty body; resolves with its id. */
  createEntry(title: string): Promise<string>;
}

const MemloreCore = requireNativeModule<MemloreCoreModule>('MemloreCore');

export default MemloreCore;
