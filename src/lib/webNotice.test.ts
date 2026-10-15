import { describe, expect, it } from 'vitest'
import { formatWebNotice } from './webNotice'

/** Fake `t` that echoes the key and its interpolation values. */
function t(key: string, values?: Record<string, unknown>): string {
  return values ? `${key}${JSON.stringify(values)}` : key
}

describe('formatWebNotice', () => {
  it('formats a replaced notice with a translated field label and title', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'entry_date', title: 'Trip' }, t)).toBe(
      'sync.web_notice.replaced{"field":"sync.web_notice.field.entry_date","title":"Trip"}',
    )
  })

  it('maps tag_add:/tag_remove: keys to their labels, ignoring the id', () => {
    expect(
      formatWebNotice({ kind: 'replaced', field: 'tag_add:abc-123', title: 'A' }, t),
    ).toContain('"field":"sync.web_notice.field.tag_add"')
    expect(formatWebNotice({ kind: 'replaced', field: 'tag_remove:abc', title: 'A' }, t)).toContain(
      '"field":"sync.web_notice.field.tag_remove"',
    )
  })

  it('falls back to the Untitled string when the title is missing or empty', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'title' }, t)).toContain(
      '"title":"sync.web_notice.untitled"',
    )
    expect(formatWebNotice({ kind: 'replaced', field: 'title', title: '' }, t)).toContain(
      '"title":"sync.web_notice.untitled"',
    )
  })

  it('formats a refused field notice with a translated known reason', () => {
    expect(
      formatWebNotice({ kind: 'refused', field: 'journal_id', title: 'A', reason: 'journal' }, t),
    ).toBe(
      'sync.web_notice.refused{"field":"sync.web_notice.field.journal_id","title":"A","reason":"sync.web_notice.reason.journal"}',
    )
  })

  it('formats a refused notice without a field as a failed entry creation', () => {
    expect(formatWebNotice({ kind: 'refused', title: 'A', reason: 'no_journal' }, t)).toBe(
      'sync.web_notice.refused_create{"title":"A","reason":"sync.web_notice.reason.no_journal"}',
    )
  })

  it('falls back to the unknown reason string carrying the raw code', () => {
    expect(formatWebNotice({ kind: 'refused', field: 'title', reason: 'quota_x' }, t)).toContain(
      '"reason":"sync.web_notice.reason.unknown{\\"code\\":\\"quota_x\\"}"',
    )
  })

  it('uses the generic error reason when a refusal has no reason', () => {
    expect(formatWebNotice({ kind: 'refused', field: 'title' }, t)).toContain(
      '"reason":"sync.web_notice.reason.error"',
    )
  })

  it('keeps an unknown field key readable through the unknown field label', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'mood_v2', title: 'A' }, t)).toContain(
      '"field":"sync.web_notice.field.unknown{\\"field\\":\\"mood_v2\\"}"',
    )
  })

  it('formats a waiting-for-newer-desktop notice with its title', () => {
    expect(formatWebNotice({ kind: 'waiting_newer_desktop', title: 'A' }, t)).toBe(
      'sync.web_notice.waiting_newer_desktop_titled{"title":"A"}',
    )
  })

  describe('outbox v2 kinds', () => {
    it('formats a refused create with its own sentence and the name', () => {
      for (const kind of ['create_journal', 'create_tag', 'upsert_template']) {
        expect(
          formatWebNotice({ kind: 'refused', field: kind, title: 'Work', reason: 'name_taken' }, t),
        ).toBe(
          `sync.web_notice.refused_v2.${kind}{"title":"Work","reason":"sync.web_notice.reason.name_taken"}`,
        )
      }
    })

    it('a desktop journal_not_empty refusal of a web journal delete says to sync and try again', () => {
      expect(
        formatWebNotice(
          { kind: 'refused', field: 'delete_journal', reason: 'journal_not_empty' },
          t,
        ),
      ).toBe(
        'sync.web_notice.refused_v2.delete_journal{"reason":"sync.web_notice.reason.journal_not_empty"}',
      )
    })

    it('falls back to Untitled for a named kind without a name', () => {
      expect(
        formatWebNotice({ kind: 'refused', field: 'create_tag', reason: 'invalid' }, t),
      ).toContain('"title":"sync.web_notice.untitled"')
    })

    it('keeps an unknown refusal code behind the unknown reason fallback', () => {
      expect(
        formatWebNotice({ kind: 'refused', field: 'trash_entry', reason: 'some.new_code' }, t),
      ).toBe(
        'sync.web_notice.refused_v2.trash_entry{"reason":"sync.web_notice.reason.unknown{\\"code\\":\\"some.new_code\\"}"}',
      )
    })

    // Phase 13 / 14: an entry location or insertion mode refusal names the change, never the raw kind.
    it.each(['set_entry_location', 'set_media_insertion_mode'])(
      'formats a refused %s with its own sentence',
      (kind) => {
        expect(formatWebNotice({ kind: 'refused', field: kind, reason: 'absent' }, t)).toBe(
          `sync.web_notice.refused_v2.${kind}{"reason":"sync.web_notice.reason.absent"}`,
        )
      },
    )

    it('formats a waiting notice per kind', () => {
      expect(
        formatWebNotice(
          { kind: 'waiting_newer_desktop', field: 'create_journal', title: 'Trips' },
          t,
        ),
      ).toBe('sync.web_notice.waiting_v2.create_journal{"title":"Trips"}')
      expect(formatWebNotice({ kind: 'waiting_newer_desktop', field: 'trash_entry' }, t)).toBe(
        'sync.web_notice.waiting_v2.trash_entry',
      )
      // A frame-3 intent never gets the 0.2.3 copy, even under a v2 kind name.
      expect(
        formatWebNotice(
          { kind: 'waiting_desktop_update', field: 'upsert_template', title: 'Daily' },
          t,
        ),
      ).toBe('sync.web_notice.waiting_desktop_update_titled{"title":"Daily"}')
    })

    it('formats a waiting notice with an unknown field generically', () => {
      expect(formatWebNotice({ kind: 'waiting_newer_desktop', field: 'mood_v3' }, t)).toBe(
        'sync.web_notice.waiting_newer_desktop',
      )
    })
  })
})
