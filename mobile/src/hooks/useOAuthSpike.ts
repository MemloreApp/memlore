import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';

import MemloreCore from '@/modules/memlore-core';

// Dev-only (spike 17.2): Google sign-in with the iOS OAuth client (PKCE, no
// client secret) through ASWebAuthenticationSession, the tokens in one Keychain
// item, and a read-only `files.list` of the Drive appDataFolder. Every action
// returns a summary: access and refresh tokens, the auth code, the callback URL
// and the PKCE verifier are never shown or logged (lengths and expiry only),
// and the client ID is masked.
// Read-only against Drive: metadata listing only, nothing downloaded or written.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
/** Desktop's `DRIVE_APPDATA_SCOPE` (memlore-engine `sync/gdrive_oauth.rs`), byte for byte. */
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,trashed)';
/** Refresh before a listing when the access token expires within this window. */
const REFRESH_MARGIN_MS = 60_000;
/** 50 pages of 1000: more than any test vault; stops a runaway pagination. */
const MAX_PAGES = 50;
/** Lines of the full listing written to the Metro log. */
const MAX_LOGGED_FILES = 2000;

interface ClientConfig {
  clientId: string;
  /** Google's documented iOS form: `<reversed client ID>:/oauth2redirect`. */
  redirectUri: string;
}

/** The token JSON in the Keychain item. Secret: never log. */
interface StoredTokens {
  accessToken: string;
  /** Unix ms. */
  accessExpiresAt: number;
  refreshToken: string | null;
  scope: string | null;
  /** Seconds, only sent by Google for time-limited grants (Testing status). */
  refreshTokenExpiresIn: number | null;
  /** Unix ms. */
  signedInAt: number;
  /** Unix ms of the last refresh, or null. */
  refreshedAt: number | null;
  refreshCount: number;
}

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  scope: string | null;
  refreshTokenExpiresIn: number | null;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  parent: string | null;
  trashed: boolean;
}

function clientConfig(): ClientConfig | null {
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra !== 'object' || extra === null || !('googleIosClientId' in extra)) return null;
  const clientId = extra.googleIosClientId;
  if (typeof clientId !== 'string') return null;
  const prefix = /^([a-z0-9-]+)\.apps\.googleusercontent\.com$/i.exec(clientId)?.[1];
  if (!prefix) return null;
  return { clientId, redirectUri: `com.googleusercontent.apps.${prefix}:/oauth2redirect` };
}

function requireConfig(): ClientConfig {
  const config = clientConfig();
  if (!config) {
    throw new Error('Client ID not configured (MEMLORE_GOOGLE_IOS_CLIENT_ID in mobile/.env.local)');
  }
  return config;
}

function describe(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return String(e);
}

function encodeQuery(params: [string, string][]): string {
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** The query of a callback URL (custom scheme: RN's URL parsing is not relied on). */
function parseQuery(url: string): Record<string, string> {
  const query = url.split('#')[0].split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    out[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(
      value.replace(/\+/g, ' '),
    );
  }
  return out;
}

/** Same parameters, in the same order, as desktop's `build_authorization_url`. */
function authorizationUrl(config: ClientConfig, challenge: string, state: string): string {
  return `${AUTH_URL}?${encodeQuery([
    ['client_id', config.clientId],
    ['redirect_uri', config.redirectUri],
    ['response_type', 'code'],
    ['scope', DRIVE_APPDATA_SCOPE],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
    ['access_type', 'offline'],
    ['prompt', 'consent'],
  ])}`;
}

/** Google's error fields only (token endpoint or Drive API); bodies hold no secret. */
async function googleError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = body.error;
      if (typeof error === 'string') {
        const description =
          'error_description' in body && typeof body.error_description === 'string'
            ? ` (${body.error_description})`
            : '';
        detail = `: ${error}${description}`;
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        detail = `: ${error.message}`;
      }
    }
  } catch {
    // Not JSON: the status is enough.
  }
  return `HTTP ${res.status}${detail}`;
}

async function postForm(url: string, params: [string, string][]): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeQuery(params),
  });
}

/** Like desktop's `ensure_appdata_scope`: a missing scope is fine, a wrong one is not. */
function checkScope(scope: string | null): void {
  if (scope !== null && !scope.split(/\s+/).includes(DRIVE_APPDATA_SCOPE)) {
    throw new Error(`Granted scope does not include drive.appdata: ${scope}`);
  }
}

function parseTokenResponse(body: unknown): TokenResponse {
  if (typeof body !== 'object' || body === null) throw new Error('Token response is not an object');
  const field = (key: string): unknown =>
    key in body ? (body as Record<string, unknown>)[key] : undefined;
  const accessToken = field('access_token');
  const expiresIn = field('expires_in');
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error('Token response has no access_token or expires_in');
  }
  const refreshToken = field('refresh_token');
  const scope = field('scope');
  const refreshTokenExpiresIn = field('refresh_token_expires_in');
  const parsed: TokenResponse = {
    accessToken,
    expiresIn,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : null,
    scope: typeof scope === 'string' ? scope : null,
    refreshTokenExpiresIn: typeof refreshTokenExpiresIn === 'number' ? refreshTokenExpiresIn : null,
  };
  checkScope(parsed.scope);
  return parsed;
}

/** Lengths and expiry of a token response, never the values. */
function tokenSummary(t: TokenResponse) {
  return {
    accessTokenLength: t.accessToken.length,
    expiresInSec: t.expiresIn,
    refreshTokenReturned: t.refreshToken !== null,
    refreshTokenLength: t.refreshToken?.length ?? 0,
    refreshTokenExpiresInSec: t.refreshTokenExpiresIn,
    scope: t.scope,
  };
}

async function readStored(): Promise<StoredTokens | null> {
  const item = await MemloreCore.spikeOAuthKeychainRead();
  if (!item.found) return null;
  const raw: unknown = JSON.parse(item.value);
  if (typeof raw !== 'object' || raw === null) throw new Error('Keychain item is not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.accessToken !== 'string' || typeof r.accessExpiresAt !== 'number') {
    throw new Error('Keychain item has no access token');
  }
  return {
    accessToken: r.accessToken,
    accessExpiresAt: r.accessExpiresAt,
    refreshToken: typeof r.refreshToken === 'string' ? r.refreshToken : null,
    scope: typeof r.scope === 'string' ? r.scope : null,
    refreshTokenExpiresIn:
      typeof r.refreshTokenExpiresIn === 'number' ? r.refreshTokenExpiresIn : null,
    signedInAt: typeof r.signedInAt === 'number' ? r.signedInAt : 0,
    refreshedAt: typeof r.refreshedAt === 'number' ? r.refreshedAt : null,
    refreshCount: typeof r.refreshCount === 'number' ? r.refreshCount : 0,
  };
}

function writeStored(tokens: StoredTokens): Promise<void> {
  return MemloreCore.spikeOAuthKeychainWrite(JSON.stringify(tokens));
}

async function requireStored(): Promise<StoredTokens> {
  const stored = await readStored();
  if (!stored) throw new Error('Not signed in (no Keychain item)');
  return stored;
}

/**
 * Refresh-token grant without a client secret (iOS client). Stores the result.
 * `emptySecret` sends `client_secret=` as memlore-engine's `refresh_access_token`
 * always does, to learn whether the engine could be reused as is.
 */
async function refreshStored(config: ClientConfig, stored: StoredTokens, emptySecret = false) {
  if (!stored.refreshToken) throw new Error('No refresh token stored');
  const params: [string, string][] = [
    ['grant_type', 'refresh_token'],
    ['refresh_token', stored.refreshToken],
    ['client_id', config.clientId],
  ];
  if (emptySecret) params.push(['client_secret', '']);
  const res = await postForm(TOKEN_URL, params);
  if (!res.ok) throw new Error(`Refresh failed: ${await googleError(res)}`);
  const t = parseTokenResponse(await res.json());
  const now = Date.now();
  const next: StoredTokens = {
    ...stored,
    accessToken: t.accessToken,
    accessExpiresAt: now + t.expiresIn * 1000,
    // Google keeps the refresh token; store a new one if it ever rotates.
    refreshToken: t.refreshToken ?? stored.refreshToken,
    scope: t.scope ?? stored.scope,
    refreshTokenExpiresIn: t.refreshTokenExpiresIn ?? stored.refreshTokenExpiresIn,
    refreshedAt: now,
    refreshCount: stored.refreshCount + 1,
  };
  await writeStored(next);
  return {
    stored: next,
    summary: {
      ...tokenSummary(t),
      refreshTokenRotated: t.refreshToken !== null && t.refreshToken !== stored.refreshToken,
      accessTokenChanged: t.accessToken !== stored.accessToken,
      refreshCount: next.refreshCount,
      sentEmptyClientSecret: emptySecret,
    },
  };
}

function parseFile(raw: unknown): DriveFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.mimeType !== 'string') {
    return null;
  }
  const size = typeof f.size === 'string' ? Number(f.size) : null;
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: size !== null && Number.isFinite(size) ? size : null,
    modifiedTime: typeof f.modifiedTime === 'string' ? f.modifiedTime : null,
    parent: Array.isArray(f.parents) && typeof f.parents[0] === 'string' ? f.parents[0] : null,
    trashed: f.trashed === true,
  };
}

/** `files.list?spaces=appDataFolder`, every page. Metadata only. */
async function listAppDataFolder(
  accessToken: string,
): Promise<{ files: DriveFile[]; pages: number; truncated: boolean }> {
  const files: DriveFile[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  do {
    const params: [string, string][] = [
      ['spaces', 'appDataFolder'],
      ['fields', LIST_FIELDS],
      ['pageSize', '1000'],
    ];
    if (pageToken) params.push(['pageToken', pageToken]);
    const res = await fetch(`${FILES_URL}?${encodeQuery(params)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`files.list failed: ${await googleError(res)}`);
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) throw new Error('files.list: not an object');
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.files)) {
      for (const raw of b.files) {
        const file = parseFile(raw);
        if (file) files.push(file);
      }
    }
    pageToken = typeof b.nextPageToken === 'string' ? b.nextPageToken : null;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES);
  return { files, pages, truncated: pageToken !== null };
}

/**
 * Paths from the `parents` chain. Drive reports the appDataFolder's real ID as
 * the parent of top-level items, never the alias, so a parent that is not in
 * the listing is the root.
 */
function summarize(files: DriveFile[]) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const pathOf = (file: DriveFile): string => {
    const parts = [file.name];
    let parent = file.parent;
    for (let depth = 0; parent && byId.has(parent) && depth < 32; depth += 1) {
      const p = byId.get(parent) as DriveFile;
      parts.unshift(p.name);
      parent = p.parent;
    }
    return parts.join('/');
  };
  const folders = new Map<
    string,
    { path: string; files: number; bytes: number; newest: string | null }
  >();
  for (const f of files) {
    if (f.mimeType === FOLDER_MIME)
      folders.set(f.id, { path: pathOf(f), files: 0, bytes: 0, newest: null });
  }
  let bytes = 0;
  let rootFiles = 0;
  for (const f of files) {
    if (f.mimeType === FOLDER_MIME) continue;
    bytes += f.size ?? 0;
    const folder = f.parent ? folders.get(f.parent) : undefined;
    if (!folder) {
      rootFiles += 1;
      continue;
    }
    folder.files += 1;
    folder.bytes += f.size ?? 0;
    if (f.modifiedTime && (!folder.newest || f.modifiedTime > folder.newest))
      folder.newest = f.modifiedTime;
  }
  const roots = files.filter((f) => !f.parent || !byId.has(f.parent));
  return {
    summary: {
      files: files.length - folders.size,
      folders: folders.size,
      bytes,
      // 1 expected: every top-level item sits in the one appDataFolder.
      distinctRootParents: new Set(roots.map((f) => f.parent)).size,
      rootItems: roots.slice(0, 50).map((f) => `${f.name}${f.mimeType === FOLDER_MIME ? '/' : ''}`),
      rootFiles,
      // Listed without a `trashed = false` filter, unlike desktop's queries.
      trashed: files.filter((f) => f.trashed).length,
      folderTree: [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)),
    },
    lines: files
      .map(
        (f) =>
          `${pathOf(f)}${f.mimeType === FOLDER_MIME ? '/' : ''}\t${f.size ?? '-'}\t` +
          `${f.modifiedTime ?? '-'}${f.trashed ? '\ttrashed' : ''}`,
      )
      .sort(),
  };
}

export function useOAuthSpike() {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = clientConfig() !== null;

  // Every action resolves with a summary that holds no secret; it is shown and logged as is.
  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const result = await action();
      const text = `${label}: ${JSON.stringify(result ?? null, null, 2)}`;
      setOutput(text);
      console.log(`[spike-oauth] ${text}`);
    } catch (e) {
      const text = `${label} failed: ${describe(e)}`;
      setOutput(text);
      console.log(`[spike-oauth] ${text}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    output,
    busy,
    configured,

    /**
     * Builds the URL the sign-in would open, with a throwaway PKCE pair; opens
     * nothing. The client ID is masked as `<prefix>` (never printed).
     */
    previewAuthorizationUrl: () =>
      run('preview', async () => {
        const config = requireConfig();
        const { challenge, state } = await MemloreCore.spikeOAuthPkce();
        const prefix = config.clientId.slice(0, config.clientId.indexOf('.'));
        const mask = (text: string) => text.split(prefix).join('<prefix>');
        return {
          url: mask(authorizationUrl(config, challenge, state)),
          redirectUri: mask(config.redirectUri),
          challengeLength: challenge.length,
        };
      }),

    signIn: () =>
      run('sign-in', async () => {
        const config = requireConfig();
        const { verifier, challenge, state } = await MemloreCore.spikeOAuthPkce();
        // Fresh session: no Safari cookies in or out, so the test account is typed in.
        const result = await WebBrowser.openAuthSessionAsync(
          authorizationUrl(config, challenge, state),
          config.redirectUri,
          { preferEphemeralSession: true },
        );
        // The callback URL carries the code: only its type is reported.
        if (result.type !== 'success') return { session: result.type };
        const params = parseQuery(result.url);
        if (params.state !== state) throw new Error('Callback state mismatch (ignored)');
        if (params.error) throw new Error(`Google returned error: ${params.error}`);
        if (!params.code) throw new Error('Callback has no code');
        const res = await postForm(TOKEN_URL, [
          ['grant_type', 'authorization_code'],
          ['code', params.code],
          ['client_id', config.clientId],
          ['code_verifier', verifier],
          ['redirect_uri', config.redirectUri],
        ]);
        if (!res.ok) throw new Error(`Token exchange failed: ${await googleError(res)}`);
        const t = parseTokenResponse(await res.json());
        const now = Date.now();
        await writeStored({
          accessToken: t.accessToken,
          accessExpiresAt: now + t.expiresIn * 1000,
          refreshToken: t.refreshToken,
          scope: t.scope,
          refreshTokenExpiresIn: t.refreshTokenExpiresIn,
          signedInAt: now,
          refreshedAt: null,
          refreshCount: 0,
        });
        return { session: 'success', stored: 'keychain', ...tokenSummary(t) };
      }),

    keychainStatus: () =>
      run('keychain', async () => {
        const item = await MemloreCore.spikeOAuthKeychainRead();
        if (!item.found) return { found: false };
        const stored = await readStored();
        const now = Date.now();
        return {
          found: true,
          afterFirstUnlockThisDeviceOnly: item.afterFirstUnlockThisDeviceOnly,
          accessGroup: item.accessGroup ?? null,
          modifiedAt: item.modifiedAt ? new Date(item.modifiedAt).toISOString() : null,
          accessTokenLength: stored?.accessToken.length ?? 0,
          accessExpiresInSec: stored ? Math.round((stored.accessExpiresAt - now) / 1000) : null,
          hasRefreshToken: stored?.refreshToken != null,
          refreshTokenLength: stored?.refreshToken?.length ?? 0,
          refreshTokenExpiresInSec: stored?.refreshTokenExpiresIn ?? null,
          scope: stored?.scope ?? null,
          signedInAt: stored?.signedInAt ? new Date(stored.signedInAt).toISOString() : null,
          refreshedAt: stored?.refreshedAt ? new Date(stored.refreshedAt).toISOString() : null,
          refreshCount: stored?.refreshCount ?? 0,
        };
      }),

    listAppData: () =>
      run('list', async () => {
        const config = requireConfig();
        let stored = await requireStored();
        let refreshed = false;
        if (stored.accessExpiresAt - Date.now() < REFRESH_MARGIN_MS) {
          stored = (await refreshStored(config, stored)).stored;
          refreshed = true;
        }
        const { files, pages, truncated } = await listAppDataFolder(stored.accessToken);
        const { summary, lines } = summarize(files);
        // Full metadata listing for the desktop comparison: Metro log only.
        console.log(
          `[spike-oauth] appDataFolder listing (${lines.length} items, path\tsize\tmodifiedTime):\n` +
            lines.slice(0, MAX_LOGGED_FILES).join('\n'),
        );
        return { refreshedFirst: refreshed, pages, truncated, ...summary };
      }),

    refresh: () =>
      run('refresh', async () => {
        const config = requireConfig();
        return (await refreshStored(config, await requireStored())).summary;
      }),

    /** The engine's request form: the same refresh with an empty `client_secret`. */
    refreshEmptySecret: () =>
      run('refresh-empty-secret', async () => {
        const config = requireConfig();
        return (await refreshStored(config, await requireStored(), true)).summary;
      }),

    /** "Disconnect" as the spike does it: delete the Keychain item, no call to Google. */
    disconnect: () =>
      run('disconnect', async () => ({
        keychainItemDeleted: await MemloreCore.spikeOAuthKeychainDelete(),
      })),

    /**
     * Revokes the grant at Google, then deletes the Keychain item. NOT pressed
     * in the spike: the grant is per GCP project, so it would also cut the
     * desktop and web clients signed in with the same account.
     */
    revokeGrant: () =>
      run('revoke', async () => {
        const stored = await requireStored();
        const res = await postForm(REVOKE_URL, [
          ['token', stored.refreshToken ?? stored.accessToken],
        ]);
        // 200 = revoked; 400 = already invalid (desktop's `revoke_token` accepts both).
        if (!res.ok && res.status !== 400)
          throw new Error(`Revoke failed: ${await googleError(res)}`);
        return {
          revokeStatus: res.status,
          keychainItemDeleted: await MemloreCore.spikeOAuthKeychainDelete(),
        };
      }),
  };
}
