import { useTranslation } from 'react-i18next'
import { MonitorX } from 'lucide-react'
import { AuthPageCard } from '../common/AuthPageCard'

/** Browser features the web app cannot run without. Values double as i18n key suffixes. */
export type BrowserFeature =
  | 'indexeddb'
  | 'webassembly'
  | 'crypto_subtle'
  | 'web_locks'
  | 'broadcast_channel'

interface Props {
  missing: readonly BrowserFeature[]
}

/**
 * Web only: rendered by `web/main.tsx` instead of App when the boot capability
 * probe finds a required browser feature missing (private mode, blocked storage,
 * an old browser, or an insecure origin). Lives outside App, so it relies on
 * `boot.js` for the design-system classes and on the synchronous i18n init.
 */
export function UnsupportedBrowserScreen({ missing }: Props) {
  const { t } = useTranslation('auth')

  return (
    <AuthPageCard data-testid="unsupported-browser-card" className="max-w-120 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="bg-danger/10 flex items-center justify-center rounded-full p-3">
          <MonitorX className="text-danger size-6" strokeWidth={1.75} />
        </div>
        <h1 className="font-title text-fg text-2xl font-extrabold">
          {t('unsupported_browser.title')}
        </h1>
        <p className="text-fg-secondary text-sm leading-relaxed">{t('unsupported_browser.body')}</p>
      </div>

      <div className="bg-panel-2 border-border-subtle rounded-lg border p-4">
        <p className="text-fg-muted mb-2 text-xs font-medium">
          {t('unsupported_browser.missing_label')}
        </p>
        <ul className="text-fg flex list-disc flex-col gap-1 pl-5 text-sm">
          {missing.map((feature) => (
            <li key={feature}>{t(`unsupported_browser.feature.${feature}`)}</li>
          ))}
        </ul>
      </div>

      <p className="text-fg-muted mt-4 text-center text-xs leading-relaxed">
        {t('unsupported_browser.hint')}
      </p>
    </AuthPageCard>
  )
}
