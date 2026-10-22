import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { isWeb } from '../../lib/platform'
import { Modal } from '../common/Modal'
import { Paginator } from '../common/Paginator'
import { TextInput } from '../common/TextInput'
import {
  accordionBodyClass,
  accordionDividerClass,
  accordionShellClass,
  accordionTabClass,
} from '../common/accordionClasses'

/** One entry of `src/generated/third-party-notices.json` (`pnpm notices:gen`). */
interface NoticeText {
  license: string
  text: string
  file?: string
}

interface Notice {
  kind: 'other' | 'rust' | 'js'
  name: string
  version: string | null
  license: string
  url: string
  texts: NoticeText[]
  attribution?: string
  whereUsed?: string
  note?: string
}

interface IndexedNotice {
  key: string
  notice: Notice
  haystack: string
}

const PAGE_SIZE = 50

/**
 * Notices URLs come from third-party package metadata: link only https, and
 * only on web. The desktop opener allow-list rejects almost all of these
 * hosts, so desktop shows them as selectable text instead of dead links.
 */
function linkableUrl(url: string): string | null {
  if (!isWeb) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return parsed.href
  } catch {
    // Not a URL — shown as plain text.
  }
  return null
}

function NoticeLink({ url }: { url: string }) {
  const href = linkableUrl(url)
  if (href == null) return <span className="break-all select-text">{url}</span>
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        void openUrl(href).catch(() => {})
      }}
      className="text-accent inline-flex items-center gap-1 break-all underline-offset-2 hover:underline"
    >
      {url}
      <ExternalLink className="size-3 shrink-0 opacity-60" strokeWidth={1.75} />
    </a>
  )
}

function NoticeDetails({ notice }: { notice: Notice }) {
  const { t } = useTranslation('settings')
  const fields: Array<[string, string | undefined]> = [
    [t('about_section.licenses.license'), notice.license],
    [t('about_section.licenses.attribution'), notice.attribution],
    [t('about_section.licenses.where_used'), notice.whereUsed],
    [t('about_section.licenses.note'), notice.note],
  ]
  return (
    <div className={cn(accordionBodyClass, 'flex flex-col gap-3 text-sm')}>
      <div>
        <span className="text-fg-muted">{t('about_section.licenses.source')}: </span>
        <NoticeLink url={notice.url} />
      </div>
      {fields.map(([label, value]) =>
        value ? (
          <p key={label} className="text-fg-secondary leading-relaxed break-words">
            <span className="text-fg-muted">{label}: </span>
            {value}
          </p>
        ) : null,
      )}
      {notice.texts.length === 0 ? (
        <p className="text-fg-muted">{t('about_section.licenses.no_text')}</p>
      ) : (
        notice.texts.map((text, i) => (
          <div key={i} className="flex flex-col gap-1">
            <p className="text-fg-muted text-xs">
              {text.file ? `${text.license} — ${text.file}` : text.license}
            </p>
            <pre className="border-border-subtle text-fg-secondary max-h-80 overflow-y-auto rounded-lg border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {text.text}
            </pre>
          </div>
        ))
      )}
    </div>
  )
}

interface Props {
  onClose: () => void
}

/** "Open-source licenses" dialog: the third-party notices, searchable. */
export function OpenSourceLicenses({ onClose }: Props) {
  const { t } = useTranslation('settings')
  const [items, setItems] = useState<IndexedNotice[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // 2 MB of licence text: a separate chunk, fetched only when this opens.
    import('../../generated/third-party-notices.json')
      .then((mod) => {
        if (cancelled) return
        const notices = mod.default as Notice[]
        setItems(
          notices.map((notice, i) => ({
            key: `${i}:${notice.kind}:${notice.name}@${notice.version ?? ''}`,
            notice,
            haystack: `${notice.name} ${notice.version ?? ''} ${notice.license}`.toLowerCase(),
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (items == null) return []
    const needle = query.trim().toLowerCase()
    return needle ? items.filter((item) => item.haystack.includes(needle)) : items
  }, [items, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function changePage(next: number) {
    setPage(next)
    listRef.current?.scrollTo({ top: 0 })
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Modal onClose={onClose} maxWidth={720} className="h-[90%]">
      <Modal.Header description={t('about_section.licenses.description')}>
        {t('about_section.licenses.title')}
      </Modal.Header>
      <Modal.Body scroll={false} className="gap-3">
        <TextInput
          type="search"
          value={query}
          onChange={(next) => {
            setQuery(next)
            setPage(1)
          }}
          placeholder={t('about_section.licenses.search_placeholder')}
          aria-label={t('about_section.licenses.search_placeholder')}
          spellCheck={false}
          disabled={items == null}
        />
        {items != null && (
          <p className="text-fg-muted text-xs" aria-live="polite">
            {t('about_section.licenses.count', { shown: filtered.length, total: items.length })}
          </p>
        )}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {loadFailed ? (
            <p className="text-fg-muted text-sm">{t('about_section.licenses.load_error')}</p>
          ) : items == null ? (
            <p className="text-fg-muted text-sm">{t('about_section.licenses.loading')}</p>
          ) : pageItems.length === 0 ? (
            <p className="text-fg-muted text-sm">
              {t('about_section.licenses.no_results', { query: query.trim() })}
            </p>
          ) : (
            <div className={accordionShellClass}>
              {pageItems.map(({ key, notice }, index) => {
                const isOpen = expanded.has(key)
                return (
                  <div key={key} className={index > 0 ? accordionDividerClass : undefined}>
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      aria-expanded={isOpen}
                      className={accordionTabClass}
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="text-fg font-medium break-all">{notice.name}</span>
                        {notice.version && (
                          <span className="text-fg-muted font-mono text-xs">{notice.version}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-fg-secondary max-w-60 truncate text-xs">
                          {notice.license}
                        </span>
                        <ChevronDown
                          className={cn(
                            'text-fg-muted size-4 shrink-0 transition-transform duration-(--motion-duration-base) motion-reduce:transition-none',
                            isOpen && 'rotate-180',
                          )}
                          strokeWidth={1.75}
                        />
                      </span>
                    </button>
                    {isOpen && <NoticeDetails notice={notice} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <Paginator
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={changePage}
          itemLabel={t('about_section.licenses.title')}
          variant="compact"
        />
      </Modal.Body>
    </Modal>
  )
}
