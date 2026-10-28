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

/** Spike 17.1: one file of the picked `MemloreSpike` folder. */
export interface SpikeICloudItem {
  name: string;
  /** Listed under the legacy `.name.icloud` placeholder name. */
  legacyPlaceholder: boolean;
  ubiquitous: boolean;
  /** `current` | `downloaded` | `notDownloaded` | `none` (not ubiquitous). */
  status: string;
  downloading: boolean;
  size: number;
  /** Bytes of a coordinated read; only for files already local. */
  bytesRead?: number;
}

export interface SpikeICloudListing {
  folder: string;
  wasStale: boolean;
  items: SpikeICloudItem[];
  /** Entries that are neither metadata.json nor *.bin (names never reported). */
  otherCount: number;
}

export interface SpikeICloudBookmarkStatus {
  hasBookmark: boolean;
  resolved?: boolean;
  wasStale?: boolean;
  accessGranted?: boolean;
  folder?: string;
  error?: string;
}

export interface SpikeICloudContainerProbe {
  identityToken: boolean;
  containerResolved: boolean;
  containerLeaf: string | null;
}

/** Spike 17.2: a PKCE pair (S256) and a `state` nonce. Secret: never log. */
export interface SpikeOAuthPkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** Spike 17.2: the Keychain item holding the token JSON. */
export type SpikeOAuthKeychainItem =
  | { found: false }
  | {
      found: true;
      /** Secret: never log. */
      value: string;
      afterFirstUnlockThisDeviceOnly: boolean;
      accessGroup?: string;
      /** Unix milliseconds. */
      modifiedAt?: number;
    };

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

  // Spike 17.1 (dev route `app/(dev)/spike-icloud.tsx` only, read-only; see
  // ios/ICloudSpike.swift). Reject with code ERR_SPIKE.
  // TODO(later): see docs/LATER.md (remove with the dev spike routes).
  /** Presents the folder picker; resolves with the folder name once bookmarked. */
  spikeICloudPickFolder(): Promise<string>;
  spikeICloudBookmarkStatus(): Promise<SpikeICloudBookmarkStatus>;
  spikeICloudForgetBookmark(): Promise<void>;
  spikeICloudList(): Promise<SpikeICloudListing>;
  spikeICloudStartDownloads(): Promise<{ started: string[]; failed: string[] }>;
  spikeICloudContainerProbe(): Promise<SpikeICloudContainerProbe>;
  spikeICloudScheduleBackgroundTask(): Promise<{ submitted: string }>;
  spikeICloudListLaterInBackground(delaySeconds: number): Promise<void>;
  /** JSON of the last background listing, or null. */
  spikeICloudBackgroundResult(): Promise<string | null>;

  // Spike 17.2 (dev route `app/(dev)/spike-oauth.tsx` only; see
  // ios/OAuthSpike.swift). Never log what these pass or return. Reject with
  // code ERR_SPIKE.
  // TODO(later): see docs/LATER.md (remove with the dev spike routes).
  spikeOAuthPkce(): Promise<SpikeOAuthPkce>;
  /** Writes the one Keychain item (AfterFirstUnlockThisDeviceOnly). */
  spikeOAuthKeychainWrite(value: string): Promise<void>;
  spikeOAuthKeychainRead(): Promise<SpikeOAuthKeychainItem>;
  /** Resolves false when there was no item. */
  spikeOAuthKeychainDelete(): Promise<boolean>;
}

const MemloreCore = requireNativeModule<MemloreCoreModule>('MemloreCore');

export default MemloreCore;
