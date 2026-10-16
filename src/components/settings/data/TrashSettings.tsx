import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, Lock, RotateCcw, Trash2 } from 'lucide-react'
import { useCapabilities } from '../../../hooks/useCapabilities'
import {
  WEB_EMPTY_TRASH_LIMIT,
  trashAgeDays,
  trashRowStatus,
  useTrash,
} from '../../../hooks/useTrash'
import { getIntlLocale } from '../../../lib/dates'
import { isWeb } from '../../../lib/platform'
import type { LockedView } from '../../../lib/tauri'
import type { Entry } from '../../../types/entry'
import { Button } from '../../common/Button'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { DesktopOnlyDialog } from '../../common/DesktopOnlyDialog'
import { Modal } from '../../common/Modal'
import { TextInput } from '../../common/TextInput'
import { EntryPreviewModal } from '../../chat/EntryPreviewModal'
import { SettingsGroup } from '../SettingsSurfaceCard'
import { SettingsSection } from '../SettingsSection'

/** The backend purges a locked entry only under `revealed`: under `covered`
 * the row is a redacted placeholder and the user cannot see what they would
 * destroy. Restore stays allowed — it loses nothing. A pending web delete is
 * in no Trash yet (web only), so there is nothing to purge. */
function canPurge(entry: Entry, lockedView: LockedView): boolean {
  return !entry.trash_pending_desktop && (!entry.is_locked || lockedView === 'revealed')
}

/**
 * Literal the user types on the web before a permanent delete. Not localized,
 * as the uninstall token: a mistranslated token would block or confuse the
 * one safeguard against a delete from a shared computer.
 */
const CONFIRM_TOKEN = 'DELETE'

interface TypedConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
}

/** The web's permanent-delete confirmation: armed only once `CONFIRM_TOKEN` is typed. */
function TypedConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: TypedConfirmDialogProps) {
  const { t } = useTranslation('settings')
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const inputId = useId()
  const armed = typed.trim() === CONFIRM_TOKEN && !running

  const confirm = () => {
    setRunning(true)
    void onConfirm().finally(() => {
      setRunning(false)
      onClose()
    })
  }

  return (
    <Modal onClose={onClose}>
      <Modal.Header description={description}>{title}</Modal.Header>
      <Modal.Body>
        {/* The label IS the instruction, so it is the accessible name. */}
        <label htmlFor={inputId} className="text-fg-secondary text-sm">
          {t('data_section.trash.confirm_hint', { token: CONFIRM_TOKEN })}
        </label>
        <TextInput
          id={inputId}
          className="mt-1.5"
          value={typed}
          onChange={setTyped}
          disabled={running}
          autoComplete="off"
          spellCheck={false}
          placeholder={CONFIRM_TOKEN}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
          {t('data_section.trash.cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!armed}
          loading={running}
          onClick={confirm}
        >
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

interface PurgeConfirmProps extends TypedConfirmDialogProps {
  open: boolean
}

/** Desktop: the plain confirmation. Web: typed (a browser may be shared or borrowed). */
function PurgeConfirm({ open, ...props }: PurgeConfirmProps) {
  if (!open) return null
  return isWeb ? <TypedConfirmDialog {...props} /> : <ConfirmDialog open {...props} />
}

/** A web delete the desktop has not applied yet, for an entry this vault never
 * loaded: there is no body to preview. The empty `journal_id` is the marker
 * `untitledPendingEntry` (web/src/backend/commands/trash.ts) sets. */
function hasNothingToShow(entry: Entry): boolean {
  return entry.trash_pending_desktop === true && entry.journal_id === ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface TrashRowProps {
  entry: Entry
  nowSecs: number
  lockedView: LockedView
  /** False on web until a desktop applies Trash actions: the row sits in the
   * desktop Trash, not here. */
  canAct: boolean
  /** A restore or purge for this row is running: its actions are disabled. */
  pending: boolean
  onPreview: () => void
  onRestore: () => void
  onDeleteForever: () => void
}

function TrashRow({
  entry,
  nowSecs,
  lockedView,
  canAct,
  pending,
  onPreview,
  onRestore,
  onDeleteForever,
}: TrashRowProps) {
  const { t, i18n } = useTranslation('settings')
  // Redacted under `covered`: the title is gone, so name it by its lock.
  const redacted = entry.is_locked && lockedView !== 'revealed'
  const title = redacted
    ? t('data_section.trash.locked_entry')
    : entry.title?.trim() || t('data_section.trash.untitled')
  const status = trashRowStatus(entry, nowSecs)
  const date = new Date(entry.entry_date * 1000).toLocaleDateString(getIntlLocale(i18n.language), {
    dateStyle: 'medium',
  })
  const meta =
    status.kind === 'pending'
      ? [date, t('data_section.trash.waiting_for_desktop')]
      : [
          date,
          canAct
            ? t('data_section.trash.deleted_ago', {
                count: trashAgeDays(entry.trashed_at ?? nowSecs, nowSecs),
              })
            : t('data_section.trash.in_desktop_trash'),
          t('data_section.trash.days_left', { count: status.daysLeft }),
        ]

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-fg truncate text-sm font-medium">{title}</span>
          {entry.is_locked && <Lock className="text-fg-muted size-3.5 shrink-0" aria-hidden />}
        </div>
        <p className="text-fg-muted mt-0.5 text-xs">{meta.join(' · ')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The preview refuses locked entries, so don't offer it. */}
        {!entry.is_locked && !hasNothingToShow(entry) && (
          <Button
            variant="secondary"
            size="xs"
            icon={<Eye className="size-3.5" aria-hidden />}
            onClick={onPreview}
          >
            {t('data_section.trash.preview')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="xs"
          icon={<RotateCcw className="size-3.5" aria-hidden />}
          disabled={pending}
          onClick={onRestore}
        >
          {t('data_section.trash.restore')}
        </Button>
        {canPurge(entry, lockedView) && (
          <Button variant="destructive" size="xs" disabled={pending} onClick={onDeleteForever}>
            {t('data_section.trash.delete_forever')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Settings → Data → Recently deleted. Lists the Trash and lets the user
 * preview, restore, or permanently delete entries. The 30-day retention
 * sweep lives in the backend; this screen only shows how long is left.
 */
export function TrashSettings() {
  const { t } = useTranslation('settings')
  const { entries, isLoading, error, lockedView, restore, deleteForever, empty } = useTrash()
  // On web the actions need a desktop that applies them; until then they open
  // a desktop-only notice.
  const caps = useCapabilities()
  // Captured once per mount: the Settings tab is short-lived and a day count
  // that ticks over mid-visit is not worth a timer.
  const [nowSecs] = useState(() => Math.floor(Date.now() / 1000))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Entry | null>(null)
  // The ids of the rows listed when the user asked to empty: the only ones the
  // confirmation covers (a row that arrives while it is open is never purged).
  const [confirmEmpty, setConfirmEmpty] = useState<string[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [desktopOnly, setDesktopOnly] = useState(false)
  // Web: what the last "Empty trash" left behind (one request lists at most
  // 1,000 entries; a full pending list queues none). The note shows while any
  // of the confirmed rows is still listed, whatever refetches the empty causes.
  const [emptyResult, setEmptyResult] = useState<{
    kind: 'more' | 'waiting'
    ids: ReadonlySet<string>
  } | null>(null)

  const purgeable = entries.filter((e) => canPurge(e, lockedView))
  const hasHeldBack = entries.some((e) => !e.trash_pending_desktop && !canPurge(e, lockedView))
  const emptyAgain =
    isWeb && emptyResult !== null && purgeable.some((e) => emptyResult.ids.has(e.id))

  // `ConfirmDialog` only logs a rejected action, so failures are caught here
  // and shown on the page.
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  // Rows with a restore or purge in flight. The ref guards synchronously (a
  // double-click lands before the re-render that disables the buttons); the
  // state drives that disabled state.
  const pendingRef = useRef(new Set<string>())
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set())

  const runForRow = async (id: string, action: () => Promise<unknown>) => {
    if (pendingRef.current.has(id)) return
    pendingRef.current.add(id)
    setPendingIds(new Set(pendingRef.current))
    try {
      await run(action)
    } finally {
      pendingRef.current.delete(id)
      setPendingIds(new Set(pendingRef.current))
    }
  }

  const shownError = actionError ?? error

  const emptyNow = async (ids: string[]) => {
    const queued = await empty(ids)
    setEmptyResult(
      queued < ids.length ? { kind: queued === 0 ? 'waiting' : 'more', ids: new Set(ids) } : null,
    )
  }

  // The confirmed rows; on the web one request queues at most
  // `WEB_EMPTY_TRASH_LIMIT`, so never promise more.
  const emptyCount = isWeb
    ? Math.min(confirmEmpty?.length ?? 0, WEB_EMPTY_TRASH_LIMIT)
    : (confirmEmpty?.length ?? 0)

  const hint = [
    t('data_section.trash.hint'),
    t('data_section.trash.older_versions_note'),
    ...(isWeb && caps.trashManage ? [t('data_section.trash.web_actions_note')] : []),
  ].join(' ')

  return (
    <div>
      <SettingsSection hint={hint}>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-fg-muted text-xs leading-snug">
              {emptyAgain
                ? emptyResult.kind === 'waiting'
                  ? t('data_section.trash.empty_again_waiting')
                  : t('data_section.trash.empty_again_more')
                : hasHeldBack && t('data_section.trash.empty_trash_locked_note')}
            </p>
            <Button
              variant="destructive"
              size="xs"
              className="shrink-0"
              icon={<Trash2 className="size-3.5" aria-hidden />}
              disabled={purgeable.length === 0}
              onClick={() =>
                caps.trashManage
                  ? setConfirmEmpty(purgeable.map((e) => e.id))
                  : setDesktopOnly(true)
              }
            >
              {emptyAgain
                ? t('data_section.trash.empty_again')
                : t('data_section.trash.empty_trash')}
            </Button>
          </div>

          {shownError && (
            <p role="alert" className="text-danger-text text-sm">
              {t('data_section.trash.error', { message: shownError })}
            </p>
          )}

          {entries.length === 0 ? (
            !isLoading && <p className="text-fg-muted text-sm">{t('data_section.trash.empty')}</p>
          ) : (
            // A long Trash scrolls inside its card instead of pushing the page.
            <SettingsGroup cardClassName="max-h-120 overflow-y-auto">
              {entries.map((entry) => (
                <TrashRow
                  key={entry.id}
                  entry={entry}
                  nowSecs={nowSecs}
                  lockedView={lockedView}
                  canAct={caps.trashManage}
                  pending={pendingIds.has(entry.id)}
                  onPreview={() => setPreviewId(entry.id)}
                  onRestore={() =>
                    caps.trashManage
                      ? void runForRow(entry.id, () => restore(entry.id))
                      : setDesktopOnly(true)
                  }
                  onDeleteForever={() =>
                    caps.trashManage ? setPendingDelete(entry) : setDesktopOnly(true)
                  }
                />
              ))}
            </SettingsGroup>
          )}
        </div>
      </SettingsSection>

      {previewId && (
        <EntryPreviewModal
          key={previewId}
          entryId={previewId}
          allowDeleted
          onClose={() => setPreviewId(null)}
        />
      )}

      <DesktopOnlyDialog
        open={desktopOnly}
        onClose={() => setDesktopOnly(false)}
        title={t('data_section.trash.desktop_only_title')}
        body={t('data_section.trash.desktop_only_body')}
      />

      <PurgeConfirm
        open={pendingDelete !== null}
        title={t('data_section.trash.delete_forever_title')}
        description={t('data_section.trash.delete_forever_body')}
        confirmLabel={t('data_section.trash.delete_forever')}
        onConfirm={() => {
          const id = pendingDelete?.id
          return id ? runForRow(id, () => deleteForever(id)) : Promise.resolve()
        }}
        onClose={() => setPendingDelete(null)}
      />

      <PurgeConfirm
        open={confirmEmpty !== null}
        title={t('data_section.trash.empty_trash_title')}
        description={
          hasHeldBack
            ? `${t('data_section.trash.empty_trash_body', { count: emptyCount })} ${t('data_section.trash.empty_trash_locked_note')}`
            : t('data_section.trash.empty_trash_body', { count: emptyCount })
        }
        confirmLabel={t('data_section.trash.empty_trash')}
        onConfirm={() => {
          const ids = confirmEmpty
          return ids ? run(() => emptyNow(ids)) : Promise.resolve()
        }}
        onClose={() => setConfirmEmpty(null)}
      />
    </div>
  )
}
