/**
 * The outbox v3 kinds the web backend can actually write today. A web capability gated on a kind
 * needs the kind both advertised by a synced desktop AND listed here, so no affordance appears
 * before its web command exists. Phases 10–14 add each kind here in the same change that adds its
 * web handler.
 */
export const WEB_IMPLEMENTED_KINDS: ReadonlySet<string> = new Set<string>([
  // Phase 10.2: journals, tags, templates and the entry trash.
  'upsert_tag',
  'upsert_journal',
  'delete_tag',
  'delete_journal',
  'upsert_template',
  'delete_template',
  'trash_entry',
  // Phase 11.1: Trash management.
  'restore_entry',
  'purge_entry',
  'empty_trash',
  // Phase 12.1: memory delete and persona edit.
  'delete_memory_item',
  'update_persona',
  // Phase 13.1: entry location and media insertion mode.
  'set_entry_location',
  'set_media_insertion_mode',
  // Phase 14.1: file and audio file attachments, and media delete.
  'attach_media',
  'delete_media',
])
