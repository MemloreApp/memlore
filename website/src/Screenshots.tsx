import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { format, msg } from './i18n/messages'
import type { Messages } from './i18n/messages/en'

type ShotId = keyof Messages['landing']['screenshots']['items']

// Page order. Regenerate the images with website/scripts/screenshots.ts.
const SHOT_IDS: ShotId[] = [
  'write',
  'search',
  'home',
  'calendar',
  'gallery',
  'lock',
  'tags',
  'stats',
  'chat',
  'focus',
  'appearance',
  'sync',
  'locks',
  'data',
]

const images = import.meta.glob<string>('./screenshots/*.webp', { eager: true, import: 'default' })
const imageFor = (id: ShotId, suffix = '') => images[`./screenshots/${id}${suffix}.webp`]
const wrap = (index: number) => (index + SHOT_IDS.length) % SHOT_IDS.length
const advance = (by: number) => (slide: { index: number }) => ({
  index: wrap(slide.index + by),
  dir: by,
})

/** Cards in two rows; the last one shown says "+N" for the rest, which stay in the viewer. */
export function Screenshots() {
  const t = msg().landing.screenshots
  const grid = useRef<HTMLUListElement>(null)
  const [shown, setShown] = useState(SHOT_IDS.length)
  const [open, setOpen] = useState<number | null>(null)

  useLayoutEffect(() => {
    const list = grid.current
    if (!list) return
    // auto-fill keeps empty tracks, so hiding cards never changes the column count.
    const layout = () => {
      const columns = getComputedStyle(list).gridTemplateColumns.split(' ').length
      setShown(Math.min(SHOT_IDS.length, Math.max(columns, 1) * 2))
    }
    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const more = SHOT_IDS.length - shown
  return (
    <section className="shots-section" id="screenshots" aria-labelledby="shots-title">
      <div className="section-heading shots-heading">
        <div>
          <h2 id="shots-title">{t.title}</h2>
          <p>{t.subtitle}</p>
        </div>
      </div>
      <ul className="shots" ref={grid}>
        {SHOT_IDS.map((id, index) => {
          const item = t.items[id]
          const last = more > 0 && index === shown - 1
          return (
            <li key={id} hidden={index >= shown}>
              <button
                type="button"
                className="shot"
                aria-label={
                  last
                    ? format(t.openMore, { label: item.label, count: more })
                    : format(t.open, { label: item.label })
                }
                onClick={() => setOpen(index)}
              >
                <img src={imageFor(id, '-thumb')} alt="" width={560} height={350} loading="lazy" />
                <span className="shot-ribbon">{item.label}</span>
                {last && (
                  <span className="shot-more" aria-hidden="true">
                    +{more}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {open !== null && <ShotViewer start={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function ShotViewer({ start, onClose }: { start: number; onClose: () => void }) {
  const t = msg().landing.screenshots
  const ref = useRef<HTMLDialogElement>(null)
  const [{ index, dir }, setSlide] = useState({ index: start, dir: 0 })

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    dialog.focus()
    return () => {
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        setSlide(advance(event.key === 'ArrowRight' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Warm the neighbours so arrowing through does not wait on the network.
  useEffect(() => {
    for (const by of [-1, 1]) {
      new Image().src = imageFor(SHOT_IDS[wrap(index + by)])
    }
  }, [index])

  const id = SHOT_IDS[index]
  const item = t.items[id]
  return (
    <dialog
      ref={ref}
      className="shot-viewer"
      aria-label={t.viewer}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <figure
        key={index}
        className="shot-slide"
        data-dir={dir > 0 ? 'next' : dir < 0 ? 'prev' : undefined}
      >
        <img src={imageFor(id)} alt={item.alt} width={1800} height={1125} />
        <figcaption className="shot-ribbon">{item.label}</figcaption>
      </figure>
      <button
        type="button"
        className="shot-viewer-button shot-viewer-prev"
        aria-label={t.previous}
        onClick={() => setSlide(advance(-1))}
      >
        <ChevronLeft className="size-5" />
      </button>
      <button
        type="button"
        className="shot-viewer-button shot-viewer-next"
        aria-label={t.next}
        onClick={() => setSlide(advance(1))}
      >
        <ChevronRight className="size-5" />
      </button>
      <button
        type="button"
        className="shot-viewer-button shot-viewer-close"
        aria-label={t.close}
        onClick={onClose}
      >
        <X className="size-5" />
      </button>
      <p className="shot-viewer-counter" aria-live="polite">
        {index + 1} / {SHOT_IDS.length}
      </p>
    </dialog>
  )
}
