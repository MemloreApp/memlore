import { requireNativeModule } from 'expo';

/** What the vault on this device needs at launch. */
export type StartupMode = 'first_launch' | 'password_locked' | 'boot_file_corrupt';

/** `code` of the errors the native module rejects with. */
export type MemloreErrorCode = 'ERR_LOCKED' | 'ERR_WRONG_PASSWORD' | 'ERR_IO' | 'ERR_FORMAT';

/** One row of the entry list (locked and invisible entries are never listed). */
export interface EntryTitle {
  id: string;
  title: string | null;
  /** Unix seconds. */
  entryDate: number;
}

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
  /** Newest first, at most `limit`. */
  listEntryTitles(limit: number): Promise<EntryTitle[]>;
  /**
   * The entry's Yjs document (full state) as base64; '' when it has no body
   * yet. Rejects with ERR_IO for an entry the list does not show.
   */
  loadEntryYjs(id: string): Promise<string>;
  /**
   * The editor's save: the FULL document state (base64 of
   * `Y.encodeStateAsUpdate`), merged into the stored one like the desktop
   * save, plus the search text and the list preview.
   */
  saveEntryYjs(
    id: string,
    fullStateB64: string,
    contentText: string,
    previewText: string,
  ): Promise<void>;
}

const MemloreCore = requireNativeModule<MemloreCoreModule>('MemloreCore');

export default MemloreCore;
