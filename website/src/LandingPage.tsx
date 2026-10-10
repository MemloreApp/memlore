import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  AtSign,
  BarChart3,
  Blocks,
  BookOpen,
  CalendarClock,
  Check,
  Cloud,
  Columns3,
  Code2,
  Cpu,
  Download,
  EyeOff,
  FileText,
  Globe,
  Hash,
  Heading,
  Heart,
  Highlighter,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  Laptop,
  Layers,
  Lightbulb,
  Lock,
  Maximize2,
  MessageCircle,
  Mic,
  Minus,
  MessageSquareQuote,
  Monitor,
  MoreHorizontal,
  Palette,
  PenLine,
  Play,
  Puzzle,
  RefreshCw,
  ScanSearch,
  ServerOff,
  Sigma,
  Smartphone,
  Sparkles,
  Type,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { latestStableRelease } from './changelog/changelogData'
import {
  aiFeatureRequestUrl,
  downloadUrl,
  editorFeatureRequestUrl,
  githubUrl,
  introVideoEmbedUrl,
  licenseUrl,
  webAppLive,
  webAppUrl,
} from './links'
import { DEFAULT_DESIGN_SYSTEM, isTrustedIframeEvent, sendDemoCommand } from './demoBridge'
import type { DesignSystem } from './demoBridge'
import HeadFollowLogo, { preloadHeadSprites } from './HeadFollowLogo'
import { DownloadLink, SiteHeader } from './SiteHeader'
import { useWideViewport } from './useWideViewport'
import { LedgerGap, LedgerRule, SectionIndex } from './Ledger'
import { SiteFooterBar } from './SiteFooterBar'
import { logoSrc } from './logoDirection'
import { NATURAL_EARTH_LAND_D } from './naturalEarthLand'
import demoPoster from './demoPoster.webp'
import { currentLocale, msg } from './i18n/messages'
import type { Messages } from './i18n/messages/en'

const aiIcons = {
  titles: Heading,
  summaries: Highlighter,
  deeper: Lightbulb,
  continue: PenLine,
  chat: MessageCircle,
  ask: MessageSquareQuote,
  memories: UserRound,
  reviews: BarChart3,
  search: ScanSearch,
  emotion: Heart,
  time: CalendarClock,
  image: ImagePlus,
  coming: Puzzle,
  request: ArrowUpRight,
  device: Cpu,
} as const
const lockIcons = {
  app: Lock,
  second: KeyRound,
  invisible: EyeOff,
} as const
const platformIcons = {
  macOS: Laptop,
  Web: Globe,
  'Windows & Linux': Monitor,
  'iOS & Android': Smartphone,
} as const
type ComparisonProductName = 'Memlore' | 'Day One' | 'Journey' | 'Apple Journal'
type ComparisonLevel = 1 | 2 | 3 | 4
type ComparisonMark = 'yes' | 'no' | 'partial' | 'soon' | ComparisonLevel

type ComparisonProduct = {
  name: ComparisonProductName
  note: string
  sourceUrl?: string
}

type ComparisonRow = {
  id: keyof Messages['landing']['compare']['rows']
  marks: Record<ComparisonProductName, ComparisonMark>
}

function markLabel(mark: ComparisonMark) {
  if (typeof mark === 'number') return msg().landing.compare.levels[mark - 1]
  return msg().landing.compare.marks[mark]
}

function rowText(id: ComparisonRow['id']): { label: string; description?: string } {
  return msg().landing.compare.rows[id]
}

function LevelDial({ mark, product }: { mark: ComparisonLevel; product: ComparisonProductName }) {
  const explanation = msg().landing.compare.levels[mark - 1]
  const label = `${product}: ${explanation}`
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })
  const hover = useHover(context, { move: false, delay: { open: 80, close: 0 } })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      <span
        ref={refs.setReference}
        className="mark mark-level"
        data-level={mark}
        role="img"
        {...getReferenceProps()}
        aria-label={label}
        tabIndex={0}
      >
        <span className="level-dial" aria-hidden="true" />
      </span>
      {open ? (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            className="mark-tip"
            style={floatingStyles}
            {...getFloatingProps()}
          >
            {explanation}
          </span>
        </FloatingPortal>
      ) : null}
    </>
  )
}

function MarkIcon({ mark, product }: { mark: ComparisonMark; product: ComparisonProductName }) {
  const label = `${product}: ${markLabel(mark)}`
  if (typeof mark === 'number') {
    return <LevelDial mark={mark} product={product} />
  }
  if (mark === 'yes') {
    return (
      <span className="mark mark-yes" role="img" aria-label={label}>
        <Check className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'no') {
    return (
      <span className="mark mark-no" role="img" aria-label={label}>
        <X className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'soon') {
    return (
      <span className="mark mark-soon" role="img" aria-label={label}>
        {msg().landing.compare.marks.soon}
      </span>
    )
  }
  return (
    <span className="mark mark-partial" role="img" aria-label={label}>
      <Minus className="size-4" strokeWidth={2} aria-hidden="true" />
    </span>
  )
}

/* The two-way dashed arrow shared by the encrypt and sync figures. */
function ExchangeArrow() {
  return (
    <svg className="encrypt-arrow" viewBox="0 0 72 40" aria-hidden="true">
      <path className="encrypt-dash" d="M8 11 H54" />
      <path d="M48 6 L58 11 L48 16" />
      <path className="encrypt-dash" d="M64 29 H18" />
      <path d="M24 24 L14 29 L24 34" />
    </svg>
  )
}

function EncryptArrow({ label, blocked = false }: { label: string; blocked?: boolean }) {
  return (
    <div className="encrypt-link">
      {blocked ? (
        <svg className="encrypt-arrow encrypt-arrow-blocked" viewBox="0 0 72 40" aria-hidden="true">
          <path d="M6 20 H28" />
          <path d="M66 20 H44" />
          <path d="M32 13 L40 27" />
          <path d="M40 13 L32 27" />
        </svg>
      ) : (
        <ExchangeArrow />
      )}
      <small>{label}</small>
    </div>
  )
}

function EncryptFigure() {
  return (
    <figure className="illust illust-encrypt" aria-hidden="true">
      <div className="encrypt-scene">
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <FileText className="size-10" />
          </div>
          <small>{msg().landing.encrypt.content}</small>
        </article>
        <EncryptArrow label={msg().landing.encrypt.password} />
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <span className="encrypt-orbit" />
            <Cloud className="size-8" />
          </div>
          <small>{msg().landing.encrypt.cloud}</small>
        </article>
        <EncryptArrow label={msg().landing.encrypt.noAccess} blocked />
        <article className="encrypt-card encrypt-card-muted">
          <div className="encrypt-card-body">
            <Users className="size-10" />
          </div>
          <small>{msg().landing.encrypt.others}</small>
        </article>
        <p className="encrypt-unseen">
          <EyeOff className="size-5" />
          {msg().landing.encrypt.unseen}
        </p>
      </div>
    </figure>
  )
}

/* Brand marks: Google Drive (official geometry) and iCloud. Fills are brand
   colours on purpose — the rest of the figure paints through the tokens. */
function GoogleDriveMark() {
  return (
    <svg className="sync-logo" viewBox="0 0 87.3 78" aria-hidden="true">
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  )
}

function ICloudMark() {
  return (
    <svg className="sync-logo sync-logo-cloud" viewBox="0 0 64 40" aria-hidden="true">
      <g fill="#3693f3">
        <circle cx="22" cy="19" r="14" />
        <circle cx="40" cy="15" r="11" />
        <circle cx="50" cy="26" r="10" />
        <rect x="14" y="22" width="40" height="14" rx="7" />
      </g>
    </svg>
  )
}

function MoreCloudsMark() {
  return (
    <span className="sync-logo sync-logo-more" aria-hidden="true">
      <MoreHorizontal className="size-3" />
    </span>
  )
}

// Marks drawn in the cloud card, in order. `more` is the dashed placeholder
// standing in for the cloud services still to come.
// TODO(later): only gdrive and icloud ship today — see docs/LATER.md.
const syncProviders = ['gdrive', 'icloud', 'more'] as const

const syncLogos: Record<(typeof syncProviders)[number], () => ReactElement> = {
  gdrive: GoogleDriveMark,
  icloud: ICloudMark,
  more: MoreCloudsMark,
}

function SyncLink({ icon: Icon, label }: { icon: typeof Lock; label: string }) {
  return (
    <div className="encrypt-link sync-link">
      <Icon className="sync-link-icon size-4" />
      <ExchangeArrow />
      <small>{label}</small>
    </div>
  )
}

/* Borrows the encrypt figure's scene/card/link classes — restyling
   `.encrypt-*` in styles.css reshapes this figure too. */
function SyncFigure() {
  return (
    <figure className="illust illust-encrypt illust-sync" aria-hidden="true">
      <div className="encrypt-scene">
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <Laptop className="size-10" />
          </div>
          <small>{msg().landing.sync.thisDevice}</small>
        </article>
        <SyncLink icon={Lock} label={msg().landing.sync.encrypted} />
        <article className="encrypt-card">
          <div className="encrypt-card-body sync-providers">
            {syncProviders.map((provider) => {
              const Mark = syncLogos[provider]
              return <Mark key={provider} />
            })}
          </div>
          <small>{msg().landing.sync.ownCloud}</small>
        </article>
        <SyncLink icon={RefreshCw} label={msg().landing.sync.synced} />
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <Smartphone className="size-10" />
          </div>
          <small>{msg().landing.sync.otherDevices}</small>
        </article>
        <p className="encrypt-unseen">
          <ServerOff className="size-5" />
          {msg().landing.sync.unseen}
        </p>
      </div>
    </figure>
  )
}

const lockIds = ['app', 'second', 'invisible'] as const

function LocksFigure() {
  const { app, second, invisible } = msg().landing.locks.items
  const AppIcon = lockIcons.app
  const SecondIcon = lockIcons.second
  const InvisibleIcon = lockIcons.invisible
  return (
    <figure className="illust illust-locks" aria-hidden="true">
      <article data-lock="app">
        <p>
          <AppIcon className="size-5" />
          <strong>{app.title}</strong>
        </p>
        <div className="lock-peers">
          <article data-lock="second">
            <p>
              <SecondIcon className="size-5" />
              <strong>{second.title}</strong>
            </p>
          </article>
          <article data-lock="invisible">
            <p>
              <InvisibleIcon className="size-5" />
              <strong>{invisible.title}</strong>
            </p>
          </article>
        </div>
      </article>
    </figure>
  )
}

const editorPanes = [
  { id: 'text' as const, Icon: Type },
  { id: 'math' as const, Icon: Sigma },
  { id: 'code' as const, Icon: Code2 },
  { id: 'media' as const, Icon: ImageIcon },
  { id: 'slash' as const, mark: '/' },
  { id: 'mention' as const, Icon: AtSign },
  { id: 'markdown' as const, Icon: Hash },
  { id: 'plugins' as const, Icon: Puzzle },
  {
    id: 'request' as const,
    Icon: ArrowUpRight,
    href: editorFeatureRequestUrl,
  },
]

function EditorFigure() {
  return (
    <figure className="illust illust-editor">
      {editorPanes.map((pane) => {
        const inner = (
          <>
            {'mark' in pane ? (
              <span className="ed-slash-mark">{pane.mark}</span>
            ) : (
              <pane.Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{msg().landing.editor.panes[pane.id]}</span>
          </>
        )
        const className = `ed-card ed-${pane.id}`
        if ('href' in pane) {
          return (
            <a
              key={pane.id}
              className={className}
              href={pane.href}
              target="_blank"
              rel="noreferrer"
            >
              {inner}
            </a>
          )
        }
        return (
          <div key={pane.id} className={className} aria-hidden="true">
            {inner}
          </div>
        )
      })}
      <div className="ed-empty" aria-hidden="true" />
    </figure>
  )
}

const emotionOptions = [
  { key: 'bad' as const, emoji: '\u{1F61E}' },
  { key: 'neutral' as const, emoji: '\u{1F610}' },
  { key: 'good' as const, emoji: '\u{1F60A}' },
]

function EmotionsFigure() {
  return (
    <figure className="illust illust-emotions" aria-hidden="true">
      <p className="emotion-prompt">{msg().landing.emotions.prompt}</p>
      <div className="emotion-options">
        {emotionOptions.map((option) => (
          <span
            key={option.key}
            data-emotion={option.key}
            data-selected={option.key === 'good' ? '' : undefined}
          >
            <span>{option.emoji}</span>
            <span className="emotion-label">{msg().landing.emotions.options[option.key]}</span>
          </span>
        ))}
      </div>
    </figure>
  )
}

function MapPhoto({
  x,
  y,
  rotate,
  variant,
  delay,
}: {
  x: number
  y: number
  rotate: number
  variant: 'image' | 'video' | 'audio'
  delay: string
}) {
  return (
    <g data-map-pin={variant} transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <g className="map-pin-bob" style={{ animationDelay: delay }}>
        <rect className="map-photo-frame" x="-26" y="-52" width="52" height="40" rx="5" />
        {/* Lucide glyphs drawn on their native 24x24 grid, then centred in the frame. */}
        <g className="map-icon" transform="translate(0 -32) scale(0.92) translate(-12 -12)">
          {variant === 'image' ? (
            <>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </>
          ) : variant === 'video' ? (
            <>
              <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </>
          ) : (
            <>
              <path d="M2 10v3" />
              <path d="M6 6v11" />
              <path d="M10 3v18" />
              <path d="M14 8v7" />
              <path d="M18 5v13" />
              <path d="M22 10v3" />
            </>
          )}
        </g>
      </g>
      <path className="map-stem" d="M0 -12 L0 10" />
      <circle className="map-dot" cx="0" cy="12" r="3.5" />
    </g>
  )
}

function LocationsFigure() {
  const cols = 8
  const rows = 4
  const width = 360
  const height = 180
  const tileW = width / cols
  const tileH = height / rows
  const tiles = Array.from({ length: cols * rows }, (_, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    return (
      <rect key={`${col}-${row}`} x={col * tileW} y={row * tileH} width={tileW} height={tileH} />
    )
  })
  return (
    <figure className="illust illust-map" aria-hidden="true">
      <svg className="map-svg" viewBox="0 0 360 180" preserveAspectRatio="none">
        <rect className="map-ocean" width="360" height="180" />
        <path className="map-land" d={NATURAL_EARTH_LAND_D} />
        <g className="map-grid">{tiles}</g>
        <MapPhoto x={128} y={87} rotate={-6} variant="image" delay="0s" />
        <MapPhoto x={182} y={52} rotate={4} variant="video" delay="0.35s" />
        <MapPhoto x={286} y={74} rotate={-3} variant="audio" delay="0.7s" />
      </svg>
    </figure>
  )
}

const transferInbound = [
  { id: 'dayOne', label: 'Day One' },
  { id: 'journey', label: 'Journey' },
  { id: 'appleJournal', label: 'Apple Journal' },
  { id: 'markdown' as const },
  { id: 'plainText' as const },
]
const transferOutbound = [
  { id: 'backup' as const },
  { id: 'markdown' as const },
  { id: 'plainText' as const },
]

function transferLabel(
  item: { id: string; label?: string } | { id: 'backup' | 'markdown' | 'plainText' },
): string {
  return 'label' in item && item.label
    ? item.label
    : msg().landing.transfer.formats[item.id as 'backup' | 'markdown' | 'plainText']
}

function transferFlowPaths(root: HTMLElement): { w: number; h: number; paths: string[] } {
  const w = root.clientWidth
  const h = root.clientHeight
  const origin = root.getBoundingClientRect()
  const hub = root.querySelector('.transfer-hub')
  if (!(hub instanceof HTMLElement) || w === 0 || h === 0) return { w, h, paths: [] }
  const hubBox = hub.getBoundingClientRect()
  const hubLeft = hubBox.left - origin.left
  const hubRight = hubBox.right - origin.left
  const hubY = hubBox.top - origin.top + hubBox.height / 2
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const gap = x2 - x1
    const c1 = x1 + Math.max(28, gap * 0.72)
    const c2 = x2 - Math.max(14, gap * 0.22)
    return `M${x1.toFixed(1)},${y1.toFixed(1)} C${c1.toFixed(1)},${y1.toFixed(1)} ${c2.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }
  const inbound = [...root.querySelectorAll('.transfer-in span')].map((el) => {
    const box = el.getBoundingClientRect()
    return curve(box.right - origin.left, box.top - origin.top + box.height / 2, hubLeft, hubY)
  })
  const outbound = [...root.querySelectorAll('.transfer-out span')].map((el) => {
    const box = el.getBoundingClientRect()
    return curve(hubRight, hubY, box.left - origin.left, box.top - origin.top + box.height / 2)
  })
  return { w, h, paths: [...inbound, ...outbound] }
}

function TransferFigure() {
  const rootRef = useRef<HTMLElement>(null)
  const [flow, setFlow] = useState({ w: 0, h: 0, paths: [] as string[] })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const update = () => setFlow(transferFlowPaths(root))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  return (
    <figure ref={rootRef} className="illust illust-transfer" aria-hidden="true">
      {flow.w > 0 ? (
        <svg
          className="transfer-flow"
          viewBox={`0 0 ${flow.w} ${flow.h}`}
          width={flow.w}
          height={flow.h}
        >
          {flow.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : null}
      <div className="transfer-col transfer-in">
        {transferInbound.map((item) => (
          <span key={item.id}>{transferLabel(item)}</span>
        ))}
      </div>
      <strong className="transfer-hub">Memlore</strong>
      <div className="transfer-col transfer-out">
        {transferOutbound.map((item) => (
          <span key={item.id}>{transferLabel(item)}</span>
        ))}
      </div>
    </figure>
  )
}

const lookCards = [
  { id: 'clay' as const, skin: 'Clay', layout: 'left' as const },
  { id: 'signature' as const, skin: 'Signature', layout: 'right' as const },
  { id: 'clean' as const, skin: 'Clean', layout: 'center' as const },
  { id: 'lumen' as const, skin: 'Lumen', layout: 'left' as const },
  { id: 'clay-dark' as const, skin: 'Clay', layout: 'right' as const },
]

function LooksFigure() {
  return (
    <figure className="illust illust-looks" aria-hidden="true">
      {lookCards.map((card) => (
        <article key={card.id} className="look-card" data-look={card.id} data-layout={card.layout}>
          <header>
            <span className="look-dots">
              <span />
              <span />
              <span />
            </span>
            <strong>{card.skin}</strong>
          </header>
          <div className="look-body">
            <aside className="look-nav">
              <span />
              <span />
              <span />
            </aside>
            <aside className="look-list">
              <span />
              <span />
              <span />
            </aside>
            <section className="look-page">
              <p>{msg().landing.looks.cards[card.id].title}</p>
              <small>{msg().landing.looks.cards[card.id].line}</small>
              <span className="look-rule" />
              <span className="look-rule" />
              <span className="look-rule" />
            </section>
          </div>
        </article>
      ))}
      <article className="look-card" data-look="editor">
        <p>{msg().landing.looks.editorCard.title}</p>
        <small>{msg().landing.looks.editorCard.line}</small>
        <span>{msg().landing.looks.editorCard.font}</span>
      </article>
    </figure>
  )
}

const lookItems = [
  {
    id: 'skins' as const,
    Icon: Layers,
  },
  {
    id: 'knobs' as const,
    Icon: Palette,
  },
  {
    id: 'layout' as const,
    Icon: Columns3,
  },
  {
    id: 'type' as const,
    Icon: Type,
  },
]

const talkItems = [
  {
    id: 'daily' as const,
    Icon: MessageCircle,
  },
  {
    id: 'voice' as const,
    Icon: Mic,
  },
  {
    id: 'mcp' as const,
    Icon: Blocks,
  },
]

function TalkFigure() {
  return (
    <figure className="illust illust-talk" aria-hidden="true">
      <article className="talk-way" data-talk="daily">
        <p>
          <MessageCircle className="size-4" />
          <strong>{msg().landing.talk.figure.daily}</strong>
        </p>
        <div className="talk-bubbles">
          <span data-who="you">{msg().landing.talk.figure.you1}</span>
          <span data-who="ai">{msg().landing.talk.figure.ai1}</span>
          <span data-who="you">{msg().landing.talk.figure.you2}</span>
          <span data-who="ai">{msg().landing.talk.figure.ai2}</span>
        </div>
      </article>
      <article className="talk-way" data-talk="voice">
        <p>
          <Mic className="size-4" />
          <strong>{msg().landing.talk.figure.voice}</strong>
        </p>
        <div className="talk-voice">
          <div className="talk-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="talk-transcript">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </article>
      <article className="talk-way" data-talk="mcp">
        <p>
          <Blocks className="size-4" />
          <strong>MCP</strong>
        </p>
        <div className="talk-mcp">
          <div className="talk-clients">
            <span>ChatGPT</span>
            <span>Claude</span>
            <span>Gemini</span>
            <span>Ollama</span>
            <span>{msg().landing.talk.figure.more}</span>
          </div>
          <div className="talk-tools">
            <span className="talk-tool">
              <ScanSearch className="size-3.5" />
              {msg().landing.talk.figure.search}
            </span>
            <span className="talk-tool">
              <BookOpen className="size-3.5" />
              {msg().landing.talk.figure.read}
            </span>
            <span className="talk-tool">
              <PenLine className="size-3.5" />
              {msg().landing.talk.figure.append}
            </span>
          </div>
        </div>
      </article>
      <p className="talk-into">
        <FileText className="size-4" />
        {msg().landing.talk.figure.into}
      </p>
    </figure>
  )
}

function PersonaFigure() {
  return (
    <figure className="illust illust-persona" aria-hidden="true">
      <svg
        className="persona-scene"
        viewBox="0 0 24 32"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g className="persona-echo" strokeWidth={1} strokeDasharray="3 2.4">
          <path d="M22 29 V20 c0-3.37-2-6.5-4-8 a5 5 0 0 0-.45-8.3" />
        </g>
        <g className="persona-self">
          <circle cx="10" cy="8" r="5" />
          <path d="M18 30 V21 a8 8 0 0 0-16 0 V30" />
        </g>
      </svg>
    </figure>
  )
}

const personaItems = [
  {
    id: 'style' as const,
    Icon: PenLine,
  },
  {
    id: 'memories' as const,
    Icon: UserRound,
  },
  {
    id: 'words' as const,
    Icon: MessageCircle,
  },
]

const pluginMarks = [
  { id: 'plugins', Icon: Puzzle },
  { id: 'tables', Icon: Columns3 },
  { id: 'charts', Icon: BarChart3 },
  { id: 'highlights', Icon: Highlighter },
  { id: 'calendar', Icon: CalendarClock },
  { id: 'audio', Icon: Mic },
]

function PluginsFigure() {
  return (
    <figure className="illust illust-plugins" aria-hidden="true">
      {pluginMarks.map((mark) => (
        <mark.Icon key={mark.id} className="size-8" strokeWidth={1.5} />
      ))}
    </figure>
  )
}

function DemoPlaceholder() {
  return (
    <div className="demo-placeholder">
      <figure className="demo-placeholder-stage">
        <HeadFollowLogo alt="" className="demo-placeholder-head" size={112} />
        <p className="demo-placeholder-title">{msg().landing.demo.placeholderTitle}</p>
        <p>{msg().landing.demo.placeholderText}</p>
      </figure>
      <LedgerRule />
    </div>
  )
}

function DemoLive() {
  const frame = useRef<HTMLIFrameElement>(null)
  // The demo is the full app (~1.5 MB gzipped, same origin, same main thread). Mount it
  // only on click so it never counts against the landing page's blocking time.
  const [started, setStarted] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  // The start button unmounts on click; hand focus to the status region so
  // keyboard and screen-reader users are not dropped on <body>.
  useEffect(() => {
    if (started) statusRef.current?.focus()
  }, [started])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [theme, setTheme] = useState<DesignSystem>(DEFAULT_DESIGN_SYSTEM)
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])
  useEffect(() => {
    if (!started) return
    const timer = window.setTimeout(
      () => setStatus((current) => (current === 'loading' ? 'error' : current)),
      30000,
    )
    const listener = (event: MessageEvent) => {
      if (!isTrustedIframeEvent(event, frame.current?.contentWindow)) return
      if (event.data.type === 'memlore-demo-ready') {
        setStatus('ready')
        window.clearTimeout(timer)
        sendDemoCommand(frame.current, { command: 'theme', designSystem: themeRef.current })
      } else setTheme(event.data.designSystem)
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      window.clearTimeout(timer)
    }
  }, [attempt, started])
  const changeTheme = (designSystem: DesignSystem) => {
    setTheme(designSystem)
    sendDemoCommand(frame.current, { command: 'theme', designSystem })
  }
  return (
    <div className="demo-stage" data-upright={status === 'ready' ? '' : undefined}>
      <div className="demo-stack" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="demo-window">
        <div className="demo-chrome">
          <p className="demo-chrome-label" id="demo-appearance-label">
            {msg().landing.demo.chooseAppearance}
            <ArrowRight className="size-3" aria-hidden="true" />
          </p>
          <div className="option-row" role="radiogroup" aria-labelledby="demo-appearance-label">
            {(
              [
                ['clay', 'Clay'],
                ['clean', 'Clean'],
                ['signature', 'Signature'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                disabled={status !== 'ready'}
                onClick={() => changeTheme(id)}
              >
                <span className={`theme-dot theme-dot-${id}`} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <a className="demo-chrome-open" href="./demo.html" target="_blank" rel="noreferrer">
            <Maximize2 className="size-3" />
            {msg().landing.demo.openSeparately}
          </a>
        </div>
        <div className="demo-viewport">
          {started && (
            <iframe
              ref={frame}
              key={attempt}
              src="./demo.html"
              title={msg().landing.demo.frameTitle}
              onError={() => setStatus('error')}
            />
          )}
          {status !== 'ready' && (
            <div className="demo-status" role="status" ref={statusRef} tabIndex={-1}>
              <img
                className="demo-poster"
                src={demoPoster}
                alt={started ? '' : msg().landing.demo.posterAlt}
                width={1280}
                height={700}
                decoding="async"
              />
              {!started && (
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  onClick={() => setStarted(true)}
                >
                  <Play className="size-4" /> {msg().landing.demo.start}
                </button>
              )}
              {started && (
                <>
                  {status === 'loading' && <span className="demo-progress" aria-hidden="true" />}
                  <BookOpen className="size-8" />
                  <h3>
                    {status === 'loading'
                      ? msg().landing.demo.loadingTitle
                      : msg().landing.demo.slowTitle}
                  </h3>
                  <p>
                    {status === 'loading'
                      ? msg().landing.demo.loadingText
                      : msg().landing.demo.slowText}
                  </p>
                </>
              )}
              {status === 'error' && (
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    data-variant="secondary"
                    onClick={() => {
                      setStatus('loading')
                      setAttempt((value) => value + 1)
                    }}
                  >
                    {msg().landing.demo.tryAgain}
                  </button>
                  <a className="text-link" href="./demo.html" target="_blank" rel="noreferrer">
                    {msg().landing.demo.openDemo} <ArrowUpRight className="size-4" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <LedgerRule />
      <p className="demo-disclaimer">{msg().landing.demo.disclaimer}</p>
    </div>
  )
}

function Demo({ wide }: { wide: boolean }) {
  return (
    <section className="demo-section" id="demo" aria-labelledby="demo-title">
      <div className="section-heading demo-heading">
        <div>
          <h2 id="demo-title">{msg().landing.demo.title}</h2>
          <p>{msg().landing.demo.subtitle}</p>
        </div>
        {wide ? (
          <p className="demo-cue">
            {msg().landing.demo.cue}
            <svg className="demo-cue-arrow" viewBox="0 0 64 72" aria-hidden="true">
              <path
                className="demo-cue-shaft"
                d="M38.2 6 C38.5 7.2 39.7 10.7 39.9 13.1 C40 15.5 39.8 18.2 39.2 20.5 C38.5 22.9 37.4 25.4 36.1 27.4 C34.7 29.4 32.9 31.2 31 32.5 C29.1 33.9 26.8 34.9 24.7 35.3 C22.7 35.8 20.4 35.8 18.5 35.4 C16.5 35 14.7 34.1 13.3 32.9 C11.9 31.8 10.8 30.1 10.2 28.5 C9.7 26.9 9.6 24.9 10 23.2 C10.4 21.5 11.4 19.7 12.8 18.3 C14.1 16.9 16.1 15.6 18.2 15 C20.3 14.3 22.9 14 25.4 14.3 C27.9 14.6 30.7 15.4 33.1 16.8 C35.6 18.2 38.1 20.2 40 22.5 C42 24.9 43.7 27.8 44.8 30.9 C45.8 33.9 46.1 37.3 46.4 40.8 C46.7 44.3 46.4 50 46.4 51.8"
              />
              <path className="demo-cue-head" d="M46.4 64.8 L38.6 50.8 L54.3 50.8 Z" />
            </svg>
          </p>
        ) : null}
      </div>
      <LedgerRule />
      {wide ? <DemoLive /> : <DemoPlaceholder />}
    </section>
  )
}

const aiItems = [
  {
    id: 'titles' as const,
  },
  {
    id: 'summaries' as const,
  },
  {
    id: 'deeper' as const,
  },
  {
    id: 'continue' as const,
  },
  {
    id: 'chat' as const,
  },
  {
    id: 'ask' as const,
  },
  {
    id: 'memories' as const,
  },
  {
    id: 'reviews' as const,
  },
  {
    id: 'search' as const,
  },
  {
    id: 'emotion' as const,
  },
  {
    id: 'time' as const,
  },
  {
    id: 'image' as const,
  },
  {
    id: 'coming' as const,
  },
  {
    id: 'request' as const,
    href: aiFeatureRequestUrl,
  },
  {
    id: 'device' as const,
  },
]

const comparisonProducts = [
  {
    name: 'Memlore',
    note: 'Still in beta, and macOS-only today. Other platforms are coming, without a date attached.',
  },
  {
    name: 'Day One',
    note: 'A polished journaling home with a long-established ecosystem. Some features need a paid plan. The app is closed source.',
    sourceUrl: 'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
  },
  {
    name: 'Journey',
    note: 'A journal across mobile, desktop, and the web. Desktop access and many features depend on a paid plan. The app is closed source.',
    sourceUrl:
      'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
  },
  {
    name: 'Apple Journal',
    note: 'A simple journal for iPhone, iPad, and Mac, kept close to the rest of Apple’s world.',
    sourceUrl: 'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
  },
] satisfies ComparisonProduct[]

const comparisonRows = [
  {
    id: 'open-source',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'password',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'your-key-only',
    marks: {
      Memlore: 'yes',
      'Day One': 'partial',
      Journey: 'partial',
      'Apple Journal': 'partial',
    },
  },
  {
    id: 'local-first',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'own-cloud',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'yes', 'Apple Journal': 'partial' },
  },
  {
    id: 'extra-locks',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'optional-ai',
    marks: { Memlore: 4, 'Day One': 2, Journey: 1, 'Apple Journal': 'no' },
  },
  {
    id: 'editor',
    marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
  },
  {
    id: 'appearance',
    marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
  },
  {
    id: 'macos',
    marks: { Memlore: 'yes', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
  },
  {
    id: 'web',
    marks: {
      Memlore: webAppLive ? 'partial' : 'soon',
      'Day One': 'yes',
      Journey: 'yes',
      'Apple Journal': 'no',
    },
  },
  {
    id: 'ios',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
  },
  {
    id: 'android',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'windows',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'linux',
    marks: { Memlore: 'soon', 'Day One': 'no', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'beta-free',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'partial' },
  },
] satisfies ComparisonRow[]

type PlatformName = 'macOS' | 'Web' | 'Windows & Linux' | 'iOS & Android'

type PlatformStatus = 'download' | 'open' | 'comingSoon'

const platformItems = [
  { name: 'macOS' as const, status: 'download' as const, href: downloadUrl },
  {
    name: 'Web' as const,
    status: webAppLive ? ('open' as const) : ('comingSoon' as const),
    href: webAppLive ? webAppUrl : undefined,
  },
  { name: 'Windows & Linux' as const, status: 'comingSoon' as const },
  { name: 'iOS & Android' as const, status: 'comingSoon' as const },
] satisfies { name: PlatformName; status: PlatformStatus; href?: string }[]

function PageActions({
  className,
  demoArrow = false,
  onWatch,
}: {
  className: string
  demoArrow?: boolean
  onWatch: () => void
}) {
  return (
    <div className={className}>
      <DownloadLink
        className="download download-hero"
        label={msg().landing.actions.download}
        ariaLabel={msg().landing.actions.downloadAria}
      />
      {webAppLive && (
        <a className="button" data-variant="secondary" href={webAppUrl}>
          <Globe className="size-4" /> {msg().landing.actions.web}
        </a>
      )}
      <a className="button" href="#demo" data-variant="secondary">
        {demoArrow ? (
          <>
            {msg().landing.actions.demo} <ArrowDown className="size-4" />
          </>
        ) : (
          msg().landing.actions.demo
        )}
      </a>
      <button
        type="button"
        className="button"
        aria-label={msg().landing.actions.watchAria}
        onClick={onWatch}
      >
        <Play className="size-4" /> {msg().landing.actions.watch}
      </button>
    </div>
  )
}

function IntroVideoDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
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
  return (
    <dialog
      ref={ref}
      className="intro-dialog"
      aria-labelledby="intro-dialog-title"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="intro-dialog-bar">
        <h2 id="intro-dialog-title">{msg().landing.intro.title}</h2>
        <button
          type="button"
          className="intro-dialog-close"
          aria-label={msg().landing.intro.close}
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="intro-frame">
        <iframe
          src={introVideoEmbedUrl}
          title={msg().landing.intro.frameTitle}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
    </dialog>
  )
}

function formatLedgerDate(isoDate: string): string {
  return new Intl.DateTimeFormat(currentLocale().dateIntl, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`))
}

export default function LandingPage() {
  const wide = useWideViewport()
  const [introOpen, setIntroOpen] = useState(false)
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {msg().chrome.skipToContent}
      </a>
      <SiteHeader homeHref="#main" />
      <main id="main" className="ledger" tabIndex={-1}>
        <section className="hero">
          <div className="hero-portrait">
            <div className="mascot-halo">
              {wide ? (
                <HeadFollowLogo
                  alt={msg().landing.hero.mascotFollowAlt}
                  className="hero-head"
                  size={168}
                />
              ) : (
                <span className="hero-head">
                  <img
                    src={logoSrc('straight')}
                    width={200}
                    height={200}
                    alt={msg().landing.hero.mascotAlt}
                  />
                </span>
              )}
            </div>
            <p>
              {msg().landing.hero.portraitLead}
              <br />
              <span>{msg().landing.hero.portraitTail}</span>
            </p>
          </div>
          <LedgerRule area="r0" />
          <div className="hero-lead" aria-hidden="true" />
          <LedgerRule area="re" accent />
          <p className="hero-eyebrow headline">
            Memlore
            <span aria-hidden="true"> · </span>
            <span className="hero-eyebrow-version">v{latestStableRelease.version}</span>
            <span aria-hidden="true"> · </span>
            <time dateTime={latestStableRelease.date}>
              {formatLedgerDate(latestStableRelease.date)}
            </time>
            <span aria-hidden="true"> · </span>
            {msg().landing.hero.openSource}
            <span aria-hidden="true"> · </span>
            <span className="hero-eyebrow-free">{msg().landing.hero.free}</span>
          </p>
          <LedgerRule area="r1" />
          <h1 className="hero-title">
            {msg().landing.hero.titleLead}
            <br />
            <span>{msg().landing.hero.titleTail}</span>
          </h1>
          <LedgerRule area="r2" />
          <p className="hero-description">
            <strong>{msg().landing.hero.descriptionLead}</strong>{' '}
            {msg().landing.hero.descriptionTail}
          </p>
          <LedgerRule area="r3" />
          <PageActions
            className="button-row page-actions"
            demoArrow
            onWatch={() => setIntroOpen(true)}
          />
          <LedgerRule area="r4" />
          <p className="hero-meta">
            {msg().landing.hero.meta} ·{' '}
            {webAppLive ? msg().landing.hero.metaWeb : msg().landing.hero.metaMac}
          </p>
        </section>
        <LedgerRule />
        <section className="spec-strip" aria-label={msg().landing.spec.label}>
          <dl>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.license}</dt>
              <dd>AGPLv3</dd>
              <small>
                <a href={licenseUrl} target="_blank" rel="noreferrer">
                  {msg().landing.spec.readSource} <ArrowRight className="size-3" />
                </a>
              </small>
            </div>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.version}</dt>
              <dd>v{latestStableRelease.version}</dd>
              <small>
                <time dateTime={latestStableRelease.date}>
                  {formatLedgerDate(latestStableRelease.date)}
                </time>
              </small>
            </div>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.sync}</dt>
              <dd>{msg().landing.spec.syncValue}</dd>
              <small>{msg().landing.spec.syncNote}</small>
            </div>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.size}</dt>
              <dd>180 MB</dd>
              <small>{msg().landing.spec.sizeNote}</small>
            </div>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.ai}</dt>
              <dd>{msg().landing.spec.aiValue}</dd>
              <small>{msg().landing.spec.aiNote}</small>
            </div>
            <div className="spec-item">
              <dt>{msg().landing.spec.terms.plugins}</dt>
              <dd>{msg().landing.spec.pluginsValue}</dd>
              <small>{msg().landing.spec.pluginsNote}</small>
            </div>
          </dl>
        </section>
        <SectionIndex>{msg().landing.demo.index}</SectionIndex>
        <Demo wide={wide} />
        <SectionIndex>{msg().landing.encrypt.index}</SectionIndex>
        <section className="split" id="features">
          <div>
            <h2>{msg().landing.encrypt.title}</h2>
            <p>{msg().landing.encrypt.text}</p>
          </div>
          <EncryptFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="sync">
          <SyncFigure />
          <div>
            <h2>{msg().landing.sync.title}</h2>
            <p>{msg().landing.sync.text}</p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="locks">
          <div className="locks-copy">
            <h2>{msg().landing.locks.title}</h2>
            <ul className="lock-list">
              {lockIds.map((id) => {
                const Icon = lockIcons[id]
                const item = msg().landing.locks.items[id]
                return (
                  <li key={id}>
                    <Icon className="size-4" />
                    <p>
                      <strong>{item.title}.</strong> {item.text}
                    </p>
                  </li>
                )
              })}
            </ul>
          </div>
          <LocksFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="editor">
          <EditorFigure />
          <div>
            <h2>{msg().landing.editor.title}</h2>
            <p>{msg().landing.editor.text}</p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="emotions">
          <div>
            <h2>{msg().landing.emotions.title}</h2>
            <p>{msg().landing.emotions.text}</p>
          </div>
          <EmotionsFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="locations">
          <LocationsFigure />
          <div>
            <h2>{msg().landing.locations.title}</h2>
            <p>{msg().landing.locations.text}</p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="import-export">
          <div>
            <h2>{msg().landing.transfer.title}</h2>
            <p>{msg().landing.transfer.text}</p>
          </div>
          <TransferFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="looks">
          <LooksFigure />
          <div>
            <h2>{msg().landing.looks.title}</h2>
            <p>
              {msg().landing.looks.textLead}
              <a href="#demo">{msg().landing.looks.demoLink}</a>
              {msg().landing.looks.textTail}
            </p>
            <ul className="lock-list">
              {lookItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{msg().landing.looks.items[item.id].title}.</strong>{' '}
                    {msg().landing.looks.items[item.id].text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="talk">
          <div>
            <h2>{msg().landing.talk.title}</h2>
            <p>{msg().landing.talk.text}</p>
            <ul className="lock-list">
              {talkItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{msg().landing.talk.items[item.id].title}.</strong>{' '}
                    {msg().landing.talk.items[item.id].text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <TalkFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="persona">
          <PersonaFigure />
          <div>
            <h2>{msg().landing.persona.title}</h2>
            <p>{msg().landing.persona.text}</p>
            <ul className="lock-list">
              {personaItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{msg().landing.persona.items[item.id].title}.</strong>{' '}
                    {msg().landing.persona.items[item.id].text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="plugins">
          <div>
            <h2>
              {msg().landing.plugins.title}
              <span className="soon-badge">{msg().landing.plugins.soon}</span>
            </h2>
            <p>{msg().landing.plugins.text}</p>
          </div>
          <PluginsFigure />
        </section>
        <SectionIndex>{msg().landing.ai.index}</SectionIndex>
        <section className="ai-section" id="ai">
          <div className="ai-intro">
            <Sparkles className="size-7" />
            <div>
              <h2>{msg().landing.ai.title}</h2>
              <p>{msg().landing.ai.text}</p>
            </div>
          </div>
          <LedgerRule />
          <div className="ai-grid">
            {aiItems.map((item) => {
              const Icon = aiIcons[item.id]
              const copy = msg().landing.ai.items[item.id]
              const inner = (
                <>
                  <span className="ai-icon" aria-hidden="true">
                    <Icon className="size-5" />
                  </span>
                  <h3>{copy.title}</h3>
                  {'text' in copy && copy.text ? <p>{copy.text}</p> : null}
                </>
              )
              if (item.id === 'device') {
                return (
                  <Fragment key={item.id}>
                    <div className="ai-empty" aria-hidden="true" />
                    <article data-ai={item.id}>{inner}</article>
                  </Fragment>
                )
              }
              if ('href' in item) {
                return (
                  <a
                    key={item.id}
                    className="ai-request"
                    data-ai={item.id}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {inner}
                  </a>
                )
              }
              return (
                <article key={item.id} data-ai={item.id}>
                  {inner}
                </article>
              )
            })}
          </div>
        </section>
        <LedgerRule />
        <LedgerGap />
        <LedgerRule />
        <section className="open-section" id="open-source">
          <div className="open-symbol" aria-hidden="true">
            <Code2 className="size-16" strokeWidth={1} />
            <span>{msg().landing.openSource.symbol}</span>
          </div>
          <div>
            <h2>{msg().landing.openSource.title}</h2>
            <p>{msg().landing.openSource.text}</p>
            <a className="text-link" href={githubUrl} target="_blank" rel="noreferrer">
              {msg().landing.openSource.github} <ArrowUpRight className="size-4.5" />
            </a>
          </div>
        </section>
        <LedgerRule />
        <LedgerGap />
        <LedgerRule />
        <section className="compare-section" id="compare" data-tone="raised">
          <div className="section-heading">
            <div>
              <h2>{msg().landing.compare.title}</h2>
              <p>{msg().landing.compare.text}</p>
            </div>
          </div>
          <LedgerRule />
          <div
            className="comparison-scroll"
            tabIndex={0}
            role="region"
            aria-label={msg().landing.compare.tableLabel}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{msg().landing.compare.compared}</span>
                  </th>
                  {comparisonProducts.map((product) => (
                    <th key={product.name} scope="col">
                      {product.name === 'Memlore' ? (
                        <span className="compare-brand">
                          <img src={logoSrc('default')} alt="" width="28" height="28" />
                          {product.name}
                        </span>
                      ) : (
                        product.name
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <strong>{rowText(row.id).label}</strong>
                      {rowText(row.id).description ? (
                        <small>{rowText(row.id).description}</small>
                      ) : null}
                    </th>
                    {comparisonProducts.map((product) => (
                      <td
                        key={product.name}
                        className={product.name === 'Memlore' ? 'memlore-cell' : undefined}
                      >
                        <MarkIcon mark={row.marks[product.name]} product={product.name} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="comparison-cards">
            {comparisonProducts.map((product) => (
              <article
                key={product.name}
                className={product.name === 'Memlore' ? 'compare-card-memlore' : undefined}
              >
                <h3>
                  {product.name === 'Memlore' ? (
                    <span className="compare-brand">
                      <img src={logoSrc('default')} alt="" width="28" height="28" />
                      {product.name}
                    </span>
                  ) : (
                    product.name
                  )}
                </h3>
                <ul>
                  {comparisonRows.map((row) => (
                    <li key={row.id}>
                      <span>
                        <strong>{rowText(row.id).label}</strong>
                        {rowText(row.id).description ? (
                          <small>{rowText(row.id).description}</small>
                        ) : null}
                      </span>
                      <MarkIcon mark={row.marks[product.name]} product={product.name} />
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <LedgerRule />
          <p className="comparison-sources">
            {msg().landing.compare.sourcesLead}{' '}
            {comparisonProducts
              .filter((product) => product.sourceUrl)
              .map((product) => (
                <a key={product.name} href={product.sourceUrl} target="_blank" rel="noreferrer">
                  {product.name} <ArrowUpRight className="size-3" />
                </a>
              ))}
            <span>{msg().landing.compare.sourcesNote}</span>
          </p>
        </section>
        <SectionIndex>{msg().landing.platforms.index}</SectionIndex>
        <section className="platform-section">
          <div>
            <h2>{msg().landing.platforms.title}</h2>
            <p>{webAppLive ? msg().landing.platforms.textWeb : msg().landing.platforms.textMac}</p>
          </div>
          <div className="platform-list">
            {platformItems.map((item) => {
              const Icon = platformIcons[item.name]
              return (
                <div key={item.name}>
                  <Icon className="size-5.5" />
                  <span>{item.name === 'Web' ? msg().landing.platforms.web : item.name}</span>
                  {item.href ? (
                    <strong>
                      <a
                        href={item.href}
                        {...(item.name === 'macOS'
                          ? {
                              target: '_blank',
                              rel: 'noreferrer',
                              'aria-label': msg().landing.platforms.downloadAria,
                            }
                          : {
                              'aria-label': msg().landing.platforms.openAria,
                            })}
                      >
                        {item.name === 'macOS' ? (
                          <>
                            <Download className="size-3.5" /> {msg().landing.platforms[item.status]}
                          </>
                        ) : (
                          <>
                            <Globe className="size-3.5" /> {msg().landing.platforms[item.status]}{' '}
                            <ArrowUpRight className="size-3" />
                          </>
                        )}
                      </a>
                    </strong>
                  ) : (
                    <small>{msg().landing.platforms[item.status]}</small>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </main>
      <footer>
        <LedgerRule />
        <div className="footer-main">
          <h2>
            {msg().landing.footer.titleLead}
            <br />
            {msg().landing.footer.titleTail}
          </h2>
          <PageActions
            className="button-row page-actions footer-actions"
            onWatch={() => setIntroOpen(true)}
          />
        </div>
        <LedgerRule />
        <SiteFooterBar homeHref="#main" />
      </footer>
      {introOpen && <IntroVideoDialog onClose={() => setIntroOpen(false)} />}
    </>
  )
}
