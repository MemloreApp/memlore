import type { WebNotice } from './tauri'

/** Minimal translate signature, so callers pass `t` from `useTranslation('nav')`. */
type Translate = (key: string, values?: Record<string, unknown>) => string

const PREFIX = 'sync.web_notice'

const KNOWN_FIELDS = new Set([
  'title',
  'entry_date',
  'emotion',
  'is_favorite',
  'journal_id',
  'tag_add',
  'tag_remove',
])

/**
 * Refusal codes the desktop sends (`src-tauri/src/sync/outbox_import.rs`), v1, v2 and v3. `absent`
 * also covers a locked, invisible or purged target, by design. `journal_not_empty` counts entries
 * the web cannot see, so its copy says to sync and try again. Any other code is shown through
 * `reason.unknown`.
 */
const KNOWN_REASONS = new Set([
  'journal',
  'tag_not_found',
  'invalid_date',
  'no_journal',
  'error',
  'entry_trashed',
  'name_taken',
  'changed_on_desktop',
  'invalid',
  'absent',
  'empty_base',
  'invalid_emotion',
  'journal_locked_or_invisible',
  'target_not_writable',
  'journal_not_empty',
  'last_journal',
  'not_in_trash',
  'media_entry_mismatch',
  'media_not_allowed',
  'media_deleted',
])

/**
 * Outbox v2 / v3 intent kinds with their own sentence (the notice `field`): `true` when the intent
 * carries a name. A v3 kind never gets a `waiting_newer_desktop` notice (frame 3 waits with
 * `waiting_desktop_update`), so only its `refused_v2` sentence exists.
 */
const V2_KINDS: ReadonlyMap<string, boolean> = new Map([
  ['create_journal', true],
  ['create_tag', true],
  ['upsert_template', true],
  ['delete_template', false],
  ['trash_entry', false],
  ['upsert_journal', true],
  ['upsert_tag', true],
  ['delete_journal', false],
  ['delete_tag', false],
  ['restore_entry', false],
  ['purge_entry', false],
  ['empty_trash', false],
  ['delete_memory_item', false],
  ['update_persona', false],
  ['set_entry_location', false],
  ['set_media_insertion_mode', false],
  ['attach_media', false],
  ['delete_media', false],
])

function fieldLabel(field: string, t: Translate): string {
  // `tag_add:<id>` / `tag_remove:<id>` — the id is not user-facing.
  const key = field.split(':', 1)[0]
  return KNOWN_FIELDS.has(key)
    ? t(`${PREFIX}.field.${key}`)
    : t(`${PREFIX}.field.unknown`, { field })
}

function reasonLabel(reason: string | undefined, t: Translate): string {
  const code = reason ?? 'error'
  return KNOWN_REASONS.has(code)
    ? t(`${PREFIX}.reason.${code}`)
    : t(`${PREFIX}.reason.unknown`, { code })
}

/** Render one structured web sync notice as a translated sentence. */
export function formatWebNotice(notice: WebNotice, t: Translate): string {
  // Before the v2 kinds: a frame-3 intent may share a v2 kind name (`upsert_template`, …).
  if (notice.kind === 'waiting_desktop_update') {
    // A frame-3 intent: no released desktop version applies it yet, so no version number.
    return notice.title
      ? t(`${PREFIX}.waiting_desktop_update_titled`, { title: notice.title })
      : t(`${PREFIX}.waiting_desktop_update`)
  }
  const v2Named = V2_KINDS.get(notice.field ?? '')
  if (v2Named !== undefined && notice.kind !== 'replaced') {
    const key =
      notice.kind === 'refused'
        ? `${PREFIX}.refused_v2.${notice.field}`
        : `${PREFIX}.waiting_v2.${notice.field}`
    const values: Record<string, unknown> = {}
    if (v2Named) values.title = notice.title || t(`${PREFIX}.untitled`)
    if (notice.kind === 'refused') values.reason = reasonLabel(notice.reason, t)
    return Object.keys(values).length > 0 ? t(key, values) : t(key)
  }
  if (notice.kind === 'waiting_newer_desktop') {
    // Not always about an entry (journal, tag, template intents), so no
    // "Untitled" fallback here.
    return notice.title
      ? t(`${PREFIX}.waiting_newer_desktop_titled`, { title: notice.title })
      : t(`${PREFIX}.waiting_newer_desktop`)
  }
  const title = notice.title || t(`${PREFIX}.untitled`)
  if (notice.kind === 'refused' && notice.field === undefined) {
    return t(`${PREFIX}.refused_create`, { title, reason: reasonLabel(notice.reason, t) })
  }
  const field = fieldLabel(notice.field ?? '', t)
  if (notice.kind === 'replaced') {
    return t(`${PREFIX}.replaced`, { field, title })
  }
  return t(`${PREFIX}.refused`, { field, title, reason: reasonLabel(notice.reason, t) })
}
